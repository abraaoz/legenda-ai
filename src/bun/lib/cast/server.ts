// Servidor HTTP local pra o Chromecast puxar o vídeo e a legenda da LAN.
// - Vídeo compatível (H.264): servido cru com byte-range (206) → seek nativo.
// - Vídeo incompatível (HEVC/x265, áudio multicanal…): transcode via HLS com a
//   estratégia estilo Jellyfin — UM ffmpeg contínuo (eficiente, sem re-seek por
//   segmento) que grava segmentos .ts sequenciais; é REINICIADO no ponto quando
//   você seeka. Throttle (pausa/continua o ffmpeg) evita transcodar longe demais
//   à frente, e há limpeza dos segmentos já consumidos → disco limitado.
//   O SEEK funciona por qualquer controlador (Google Home, TV, o app).
// - Legenda: convertida pra WebVTT (o Cast só aceita VTT) e servida com CORS.

import type { Subprocess } from 'bun'
import { extname, joinPath } from '../paths'

export interface CastServer {
  videoUrl: string
  subtitleUrl?: string
  contentType: string
  port: number
  stop: () => void
}

const VIDEO_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg'
}

export function videoMime(path: string): string {
  return VIDEO_MIME[extname(path).toLowerCase()] ?? 'video/mp4'
}

export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^﻿/, '')
    .replace(/\r+/g, '')
    .replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2')
    .trim()
  return `WEBVTT\n\n${body}\n`
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }

// Flags de features DLNA (contentFeatures.dlna.org). OP=01 → byte-seek. A
// Samsung recusa stream ao vivo (chunked); serve-se SEMPRE recurso com
// Content-Length + ranges — inclusive o transcode (arquivo crescente). CI=1
// só sinaliza "convertido".
const DLNA_FLAGS = '01700000000000000000000000000000'
const DLNA_FEAT_FILE = `DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${DLNA_FLAGS}`

/** Args de codec pro transcode (VideoToolbox no macOS, libx264 fora). */
function encoderArgs(): string[] {
  const mac = process.platform === 'darwin'
  return [
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-c:v',
    mac ? 'h264_videotoolbox' : 'libx264',
    ...(mac ? [] : ['-preset', 'veryfast']),
    '-b:v',
    '8M',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ac',
    '2',
    '-b:a',
    '192k'
  ]
}

const SEG = 6 // duração de cada segmento (s)
const SEG_EST = 6 * 1024 * 1024 // estimativa de tamanho por segmento (~6 MB) p/ dimensionar a janela
const WAIT_MS = 15000 // espera máx. um segmento aparecer

/** Sessão de transcode HLS estilo Jellyfin: ffmpeg contínuo + restart no seek. */
class HlsSession {
  private dir: string
  private mem = new Map<number, Uint8Array>() // segmentos EM RAM (servidos daqui)
  private memBytes = 0 // total em RAM (teto rígido = maxRamBytes)
  private startSeg = 0
  private head = -1 // maior segmento CONTÍGUO já produzido pelo ffmpeg atual
  private proc: Subprocess | null = null
  private paused = false
  private lastServed = 0
  private restarting = false
  private starting: Promise<void>
  private timer: ReturnType<typeof setInterval> | null = null
  // Janela (em segmentos) derivada do budget de RAM. Seek dentro dela é
  // instantâneo (já em memória); mais longe, o ffmpeg reinicia no ponto.
  private readonly ahead: number
  private readonly behind: number
  private readonly resume: number

  constructor(
    private ffmpeg: string,
    private videoPath: string,
    readonly durationSec: number,
    private maxRamBytes: number
  ) {
    const maxSegs = Math.max(8, Math.floor(maxRamBytes / SEG_EST))
    this.behind = Math.max(4, Math.round(maxSegs * 0.4)) // atrás (seek-pra-trás)
    this.ahead = Math.max(6, Math.round(maxSegs * 0.55)) // à frente (prefetch)
    this.resume = Math.round(this.ahead * 0.7)
    this.dir = joinPath(process.env.TMPDIR ?? '/tmp', `legenda-hls-${Math.floor(Math.random() * 1e9).toString(36)}`)
    this.starting = this.startAt(0)
    this.timer = setInterval(() => void this.tick(), 1000)
  }

  /** Remove um segmento da RAM (mantendo o contador de bytes). */
  private memDelete(n: number): void {
    const b = this.mem.get(n)
    if (b) {
      this.memBytes -= b.length
      this.mem.delete(n)
    }
  }

  playlist(): string {
    const n = Math.max(1, Math.ceil(this.durationSec / SEG))
    let out = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n'
    out += `#EXT-X-TARGETDURATION:${SEG}\n#EXT-X-MEDIA-SEQUENCE:0\n`
    for (let i = 0; i < n; i++) {
      const d = i === n - 1 ? this.durationSec - i * SEG : SEG
      out += `#EXTINF:${(d > 0 ? d : SEG).toFixed(3)},\nseg${i}.ts\n`
    }
    return out + '#EXT-X-ENDLIST\n'
  }

  private segPath(n: number): string {
    return joinPath(this.dir, `seg${n}.ts`)
  }

  /** Avança o `head` enquanto o próximo segmento (contíguo) existir — na RAM ou
   * ainda em arquivo. Robusto contra segmentos velhos de outras posições. */
  private async advanceHead(): Promise<void> {
    let guard = 0
    while (guard++ < 4000) {
      const next = this.head + 1
      if (this.mem.has(next) || (await Bun.file(this.segPath(next)).exists())) this.head++
      else break
    }
  }

  /** Lê o segmento n do disco pra RAM (se existir). O ffmpeg escreve arquivos;
   * a gente os move pra memória e serve de lá (o arquivo é apagado no tick). */
  private async slurp(n: number): Promise<boolean> {
    if (this.mem.has(n)) return true
    const f = Bun.file(this.segPath(n))
    if (!(await f.exists())) return false
    try {
      const bytes = new Uint8Array(await f.arrayBuffer())
      this.mem.set(n, bytes)
      this.memBytes += bytes.length
      return true
    } catch {
      return false
    }
  }

  private async startAt(seg: number): Promise<void> {
    this.killProc()
    this.startSeg = seg
    this.head = seg - 1 // o novo ffmpeg começa a produzir a partir de `seg`
    await Bun.$`mkdir -p ${this.dir}`.quiet().nothrow() // garante o dir ANTES do ffmpeg
    this.proc = Bun.spawn(
      [
        this.ffmpeg,
        '-hide_banner',
        '-loglevel',
        'error',
        '-hwaccel',
        'videotoolbox',
        '-ss',
        String(seg * SEG),
        '-i',
        this.videoPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0',
        '-c:v',
        'h264_videotoolbox',
        '-b:v',
        '8M',
        '-profile:v',
        'high',
        '-pix_fmt',
        'yuv420p',
        '-force_key_frames',
        'expr:gte(t,n_forced*6)',
        '-c:a',
        'aac',
        '-ac',
        '2',
        '-b:a',
        '192k',
        '-f',
        'hls',
        '-hls_time',
        String(SEG),
        '-hls_playlist_type',
        'vod',
        '-hls_flags',
        'temp_file+independent_segments',
        '-hls_segment_type',
        'mpegts',
        '-hls_list_size',
        '0',
        '-start_number',
        String(seg),
        '-hls_segment_filename',
        joinPath(this.dir, 'seg%d.ts'),
        joinPath(this.dir, '_ff.m3u8')
      ],
      { stdout: 'ignore', stderr: 'ignore' }
    )
    this.paused = false
  }

  private killProc(): void {
    const p = this.proc
    this.proc = null
    this.paused = false
    if (!p) return
    // SIGCONT primeiro: um ffmpeg pausado (SIGSTOP) ignora o SIGTERM até continuar.
    try {
      p.kill('SIGCONT')
    } catch {
      // ignora
    }
    try {
      p.kill('SIGKILL')
    } catch {
      // ignora
    }
  }

  private pause(p: boolean): void {
    if (!this.proc || this.paused === p) return
    try {
      this.proc.kill(p ? 'SIGSTOP' : 'SIGCONT')
      this.paused = p
    } catch {
      // ignora
    }
  }

  /** Throttle + slurp dos segmentos novos pra RAM + evicção (janela + teto de RAM). */
  private async tick(): Promise<void> {
    if (!this.restarting) {
      await this.advanceHead()
      const ahead = this.head - this.lastServed
      // Pausa se produziu além da janela OU se a RAM encheu (teto rígido).
      if (ahead > this.ahead || this.memBytes >= this.maxRamBytes) this.pause(true)
      else if (ahead < this.resume && this.memBytes < this.maxRamBytes * 0.85) this.pause(false)
    }
    const lo = this.lastServed - this.behind
    const hi = this.lastServed + this.ahead + 6
    // Move os arquivos novos pra RAM (dentro da janela) e apaga TODOS os arquivos
    // — o disco fica ~vazio; tudo é servido da memória.
    const drop: string[] = []
    try {
      const glob = new Bun.Glob('seg*.ts')
      for await (const name of glob.scan({ cwd: this.dir, onlyFiles: true })) {
        const i = Number(name.slice(3, -3))
        if (!Number.isFinite(i)) continue
        if (i >= lo && i <= hi && !this.mem.has(i)) await this.slurp(i)
        drop.push(joinPath(this.dir, name))
      }
      if (drop.length) await Bun.$`rm -f ${drop}`.quiet().nothrow() // AWAIT: senão não roda
    } catch {
      // ignora
    }
    // Evicta da RAM o que saiu da janela (seeks deixam clusters antigos).
    for (const k of [...this.mem.keys()]) if (k < lo || k > hi) this.memDelete(k)
    // Teto RÍGIDO de RAM: se ainda passar do budget (segmentos maiores que a
    // estimativa), remove os mais DISTANTES da posição até caber. Sem leak.
    while (this.memBytes > this.maxRamBytes && this.mem.size > 1) {
      let far = -1
      let farDist = -1
      for (const k of this.mem.keys()) {
        const d = Math.abs(k - this.lastServed)
        if (d > farDist) {
          farDist = d
          far = k
        }
      }
      if (far < 0) break
      this.memDelete(far)
    }
  }

  /** Devolve os BYTES do segmento n (da RAM), transcodando/reiniciando se preciso. */
  async getSegment(n: number): Promise<Uint8Array | null> {
    await this.starting // garante que o dir + ffmpeg inicial existem
    this.lastServed = n // acompanha a posição (sobe no play, desce no seek-atrás)
    this.pause(false)
    if (this.mem.has(n)) return this.mem.get(n)!
    if (await this.slurp(n)) return this.mem.get(n)!

    // Se um restart está em curso, espera antes de decidir (evita restarts concorrentes).
    if (this.restarting) await this.starting.catch(() => {})
    if (this.mem.has(n) || (await this.slurp(n))) return this.mem.get(n)!

    await this.advanceHead()
    const needRestart = n < this.startSeg || n > this.head + this.ahead
    if (needRestart && !this.restarting) {
      this.restarting = true
      this.starting = this.startAt(n).finally(() => {
        this.restarting = false
      })
      await this.starting.catch(() => {})
    }

    const deadline = Date.now() + WAIT_MS
    while (Date.now() < deadline) {
      if (this.mem.has(n) || (await this.slurp(n))) return this.mem.get(n)!
      await Bun.sleep(120)
    }
    return null
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.mem.clear()
    this.memBytes = 0
    this.killProc()
    // .then força a execução (um Bun.$ só criado, sem await/then, não roda).
    Bun.$`rm -rf ${this.dir}`.quiet().nothrow().then(
      () => {},
      () => {}
    )
  }
}

/**
 * Pré-transcode DLNA: converte o arquivo INTEIRO pra um .mkv temporário e só
 * então serve por byte-range. A Samsung recusa transcode ao vivo/crescente
 * (ela sonda o fim do arquivo pra ler o índice → trava); com o arquivo pronto,
 * toca e seeka perfeito, igual ao direct-play. Reporta progresso (0..1).
 */
export class DlnaPreTranscode {
  readonly dir: string
  readonly file: string
  private proc: Subprocess | null = null
  readonly done: Promise<boolean>

  constructor(
    ffmpeg: string,
    videoPath: string,
    durationSec: number,
    onProgress?: (fraction: number) => void
  ) {
    this.dir = joinPath(
      process.env.TMPDIR ?? '/tmp',
      `legenda-dlna-${Math.floor(Math.random() * 1e9).toString(36)}`
    )
    this.file = joinPath(this.dir, 'out.mkv')
    this.done = this.run(ffmpeg, videoPath, durationSec, onProgress)
  }

  private async run(
    ffmpeg: string,
    videoPath: string,
    durationSec: number,
    onProgress?: (fraction: number) => void
  ): Promise<boolean> {
    await Bun.$`mkdir -p ${this.dir}`.quiet().nothrow()
    const mac = process.platform === 'darwin'
    this.proc = Bun.spawn(
      [
        ffmpeg,
        '-hide_banner',
        '-loglevel',
        'error',
        ...(mac ? ['-hwaccel', 'videotoolbox'] : []),
        '-i',
        videoPath,
        ...encoderArgs(),
        '-f',
        'matroska',
        '-progress',
        'pipe:1',
        '-y',
        this.file
      ],
      { stdout: 'pipe', stderr: 'ignore' }
    )
    // Lê o progresso do ffmpeg (out_time_us) e reporta a fração concluída.
    if (onProgress && durationSec > 0 && this.proc.stdout) {
      void (async () => {
        const total = durationSec * 1e6
        for await (const chunk of this.proc!.stdout as ReadableStream<Uint8Array>) {
          const text = new TextDecoder().decode(chunk)
          const m = [...text.matchAll(/out_time_us=(\d+)/g)].pop()
          if (m) onProgress(Math.min(1, Number(m[1]) / total))
        }
      })()
    }
    const code = await this.proc.exited
    return code === 0
  }

  stop(): void {
    const p = this.proc
    this.proc = null
    if (p) {
      try {
        p.kill('SIGKILL')
      } catch {
        // ignora
      }
    }
    Bun.$`rm -rf ${this.dir}`.quiet().nothrow().then(
      () => {},
      () => {}
    )
  }
}

export function startCastServer(opts: {
  ip: string
  videoPath: string
  subtitlePath?: string
  transcode?: boolean
  ffmpegPath?: string
  durationSec?: number
  maxRamBytes?: number
  port?: number
  /** 'chromecast' (HLS + VTT) ou 'dlna' (stream TS/byte-range + SRT). */
  mode?: 'chromecast' | 'dlna'
}): CastServer {
  const useTranscode = Boolean(opts.transcode && opts.ffmpegPath)
  const dlna = opts.mode === 'dlna'
  const rawMime = videoMime(opts.videoPath)
  // Só o Chromecast usa HLS (RAM/segmentos). No DLNA o vídeo é servido por
  // byte-range em /video — cru (direct-play) ou já pré-transcodado (a Samsung
  // recusa transcode ao vivo; ver DlnaPreTranscode + manager).
  const hls =
    useTranscode && !dlna
      ? new HlsSession(
          opts.ffmpegPath!,
          opts.videoPath,
          opts.durationSec ?? 0,
          opts.maxRamBytes ?? 0.5 * 1024 ** 3
        )
      : null

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: '0.0.0.0',
    // Respostas de mídia são longas (byte-range grande). Sem isto o Bun aborta
    // a conexão em 10s → a TV/Chromecast trava em BUFFERING.
    idleTimeout: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url)
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

      if (dlna && pathname === '/subtitle.srt' && opts.subtitlePath) {
        const srt = await Bun.file(opts.subtitlePath).text()
        return new Response(srt, {
          headers: {
            'Content-Type': 'text/srt; charset=utf-8',
            'CaptionInfo.sec': req.url,
            ...CORS
          }
        })
      }

      if (hls) {
        if (pathname === '/index.m3u8') {
          return new Response(hls.playlist(), {
            headers: { 'Content-Type': 'application/x-mpegURL', ...CORS }
          })
        }
        const m = pathname.match(/^\/seg(\d+)\.ts$/)
        if (m) {
          const bytes = await hls.getSegment(Number(m[1]))
          if (!bytes) return new Response('segment timeout', { status: 503, headers: CORS })
          return new Response(bytes as unknown as BodyInit, {
            headers: { 'Content-Type': 'video/mp2t', ...CORS }
          })
        }
      }

      if (pathname === '/video') {
        const file = Bun.file(opts.videoPath)
        const size = file.size
        const base = {
          'Content-Type': rawMime,
          'Accept-Ranges': 'bytes',
          ...CORS,
          ...(dlna ? { 'contentFeatures.dlna.org': DLNA_FEAT_FILE, 'transferMode.dlna.org': 'Streaming' } : {})
        }
        const range = req.headers.get('range')
        if (range) {
          const mm = range.match(/bytes=(\d+)-(\d*)/)
          const start = mm ? Number(mm[1]) : 0
          const end = mm && mm[2] ? Math.min(Number(mm[2]), size - 1) : size - 1
          const headers = {
            ...base,
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': String(end - start + 1)
          }
          if (req.method === 'HEAD') return new Response(null, { status: 206, headers })
          return new Response(file.slice(start, end + 1), { status: 206, headers })
        }
        const headers = { ...base, 'Content-Length': String(size) }
        if (req.method === 'HEAD') return new Response(null, { headers })
        return new Response(file, { headers })
      }

      if (pathname === '/subtitle.vtt' && opts.subtitlePath) {
        const srt = await Bun.file(opts.subtitlePath).text()
        return new Response(srtToVtt(srt), {
          headers: { 'Content-Type': 'text/vtt; charset=utf-8', ...CORS }
        })
      }

      return new Response('not found', { status: 404, headers: CORS })
    }
  })

  const port = server.port ?? 0
  const origin = `http://${opts.ip}:${port}`
  // DLNA sempre usa /video (byte-range); o transcode já vem pré-convertido no
  // videoPath. Só o Chromecast usa a playlist HLS.
  const videoUrl = useTranscode && !dlna ? `${origin}/index.m3u8` : `${origin}/video`
  const subtitleUrl = opts.subtitlePath
    ? dlna
      ? `${origin}/subtitle.srt`
      : `${origin}/subtitle.vtt`
    : undefined
  const contentType = useTranscode && !dlna ? 'application/x-mpegURL' : rawMime
  return {
    videoUrl,
    subtitleUrl,
    contentType,
    port,
    stop: () => {
      hls?.stop()
      server.stop(true)
    }
  }
}
