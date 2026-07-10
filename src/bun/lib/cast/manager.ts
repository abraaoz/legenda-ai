// Orquestra o "Tocar na TV": descoberta + servidor de mídia + conexão CASTV2.
// Mantém UMA sessão ativa por vez (trocar de vídeo/TV encerra a anterior).

import type { CastDevice, CastPlaybackStatus, CastStartArgs } from '../../../shared/types'
import { resolveBinary } from '../ffmpeg'
import { logi, loge } from '../logger'
import { discoverCastDevices, discoverDlnaDevices, localIp } from './discover'
import { CastConnection } from './client'
import { DlnaConnection } from './dlna'
import { startCastServer, DlnaPreTranscode, type CastServer } from './server'

/** Interface mínima comum às duas conexões (Chromecast e DLNA). */
interface CastControllable {
  play(): Promise<unknown>
  pause(): Promise<unknown>
  stop(): Promise<unknown>
  seek(seconds: number): Promise<unknown>
  close(): void
}

interface Probe {
  video: string
  audio: string
  channels: number
  durationSec: number
}

/** Descobre codecs + duração via ffprobe (pra decidir transcode e a barra). */
async function probeVideo(path: string): Promise<Probe> {
  const ffprobe = await resolveBinary('ffprobe')
  const empty: Probe = { video: '', audio: '', channels: 2, durationSec: 0 }
  if (!ffprobe) return empty
  try {
    const proc = Bun.spawn(
      [ffprobe, '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path],
      { stdout: 'pipe', stderr: 'ignore' }
    )
    const out = await new Response(proc.stdout).text()
    await proc.exited
    const j = JSON.parse(out) as {
      streams?: Array<{ codec_type?: string; codec_name?: string; channels?: number }>
      format?: { duration?: string }
    }
    const v = j.streams?.find((s) => s.codec_type === 'video')
    const a = j.streams?.find((s) => s.codec_type === 'audio')
    return {
      video: v?.codec_name ?? '',
      audio: a?.codec_name ?? '',
      channels: a?.channels ?? 2,
      durationSec: Math.round(Number(j.format?.duration ?? 0))
    }
  } catch {
    return empty
  }
}

/** Chromecast básico só toca H.264 + áudio estéreo comum → decisão por codec.
 * O DLNA/Samsung NÃO usa isto: lá tentamos direct-play e só convertemos se a
 * TV realmente não reproduzir (a TV é a fonte da verdade — nada de transcodar
 * à toa). */
function needsTranscodeChromecast(p: Probe): boolean {
  const okVideo = p.video === 'h264'
  const okAudio = ['aac', 'mp3', 'vorbis', 'opus'].includes(p.audio) && p.channels <= 2
  return !okVideo || !okAudio
}

/** Espera a reprodução realmente começar (PLAYING + tempo avançando). Retorna
 * cedo no sucesso; no fracasso, aguarda até `maxMs` e retorna false. Usado no
 * DLNA pra decidir empiricamente se precisa converter. */
async function waitForPlayback(get: () => { state: string; t: number }, maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const { state, t } = get()
    if (state === 'PLAYING' && t > 0.5) return true
    await Bun.sleep(500)
  }
  const { state, t } = get()
  return state === 'PLAYING' && t > 0.5
}

let conn: CastControllable | null = null
let server: CastServer | null = null
let dlnaTmp: DlnaPreTranscode | null = null
let deviceName = ''
let lastDuration = 0
let statusSink: ((s: CastPlaybackStatus) => void) | null = null

export function setCastStatusSink(fn: (s: CastPlaybackStatus) => void): void {
  statusSink = fn
}

export async function castDiscover(): Promise<CastDevice[]> {
  // Procura Chromecast (mDNS) e DLNA/Samsung (SSDP) em paralelo e mescla.
  const [cast, dlna] = await Promise.all([
    discoverCastDevices(3000).catch(() => []),
    discoverDlnaDevices(3000).catch(() => [])
  ])
  const byId = new Map<string, CastDevice>()
  for (const d of [...cast, ...dlna]) byId.set(`${d.protocol}:${d.id}`, d)
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Inicia (ou troca) a reprodução na TV. */
export async function castStart(args: CastStartArgs): Promise<void> {
  await castStop()
  deviceName = args.deviceName
  lastDuration = 0
  const probe = await probeVideo(args.videoPath)
  lastDuration = probe.durationSec
  const ip = await localIp(args.deviceHost)
  logi(`Cast: servindo mídia em ${ip} para "${args.deviceName}" (${args.protocol})`)
  const onClose = (): void =>
    statusSink?.({ device: deviceName, playerState: 'STOPPED', currentTime: 0, duration: 0 })

  if (args.protocol === 'dlna') return startDlna(args, probe, ip, onClose)
  return startChromecast(args, probe, ip, onClose)
}

/**
 * DLNA/Samsung: tenta **direct-play** primeiro (barato) e observa se a TV
 * realmente começa a tocar. Só se ela NÃO reproduzir (fica em IDLE) é que
 * converte — a TV é a fonte da verdade, então nunca transcodamos à toa. E a
 * conversão é PRÉ-transcode do arquivo inteiro (a Samsung não aceita ao vivo).
 */
async function startDlna(args: CastStartArgs, probe: Probe, ip: string, onClose: () => void): Promise<void> {
  const dc = new DlnaConnection(args.controlUrl ?? '')
  conn = dc
  let curState = 'IDLE'
  let curT = 0
  dc.onStatus = (st) => {
    curState = st.playerState
    curT = st.currentTime
    if (st.duration > 0 && lastDuration === 0) lastDuration = st.duration
    statusSink?.({
      device: deviceName,
      playerState: st.playerState,
      currentTime: st.currentTime,
      duration: lastDuration || st.duration
    })
  }
  dc.onClose = onClose
  await dc.open()

  const load = (contentUrl: string, contentType: string, converted: boolean): Promise<void> =>
    dc.load({
      contentUrl,
      contentType,
      transcode: converted,
      title: args.title,
      durationSec: probe.durationSec,
      subtitleUrl: server?.subtitleUrl,
      subtitleLang: args.subtitleLang
    })

  // 1) DIRECT-PLAY (serve o arquivo cru por byte-range e deixa a TV tentar).
  server = startCastServer({
    ip,
    videoPath: args.videoPath,
    subtitlePath: args.subtitlePath,
    transcode: false,
    durationSec: probe.durationSec,
    mode: 'dlna'
  })
  await load(server.videoUrl, server.contentType, false)
  // Margem generosa: melhor esperar num fracasso (raro) do que converter à toa
  // um arquivo grande que só demorou a bufferizar na rede.
  if (await waitForPlayback(() => ({ state: curState, t: curT }), 20000)) {
    logi(`Cast: reproduzindo "${args.title}"${server.subtitleUrl ? ' com legenda' : ''} em "${args.deviceName}" (DLNA, direct-play)`)
    return
  }
  if (conn !== dc) return // usuário cancelou durante a espera

  // 2) A TV NÃO reproduziu o formato original → converter (raro). Pré-transcode
  //    do arquivo inteiro, com progresso; depois serve por byte-range.
  logi(
    `Cast: a TV não reproduziu ${probe.video}/${probe.audio} ${probe.channels}ch no formato original — convertendo o vídeo (pode demorar)…`
  )
  server.stop()
  server = null
  const ffmpegPath = (await resolveBinary('ffmpeg')) ?? undefined
  if (!ffmpegPath) throw new Error('A TV não reproduz este vídeo e o ffmpeg não foi encontrado para convertê-lo.')
  let lastPct = -5
  dlnaTmp = new DlnaPreTranscode(ffmpegPath, args.videoPath, probe.durationSec, (frac) => {
    const pct = Math.floor(frac * 100)
    if (pct >= lastPct + 5) {
      lastPct = pct
      logi(`Cast: convertendo para a TV… ${pct}%`)
      statusSink?.({ device: deviceName, playerState: 'BUFFERING', currentTime: 0, duration: probe.durationSec })
    }
  })
  const current = dlnaTmp
  const ok = await dlnaTmp.done
  if (dlnaTmp !== current || conn !== dc) return // cancelado durante a conversão
  if (!ok) throw new Error('Falha ao converter o vídeo para a TV.')
  logi('Cast: conversão concluída — iniciando reprodução.')
  server = startCastServer({
    ip,
    videoPath: dlnaTmp.file,
    subtitlePath: args.subtitlePath,
    transcode: false,
    durationSec: probe.durationSec,
    mode: 'dlna'
  })
  await load(server.videoUrl, server.contentType, true)
  logi(`Cast: reproduzindo "${args.title}"${server.subtitleUrl ? ' com legenda' : ''} em "${args.deviceName}" (DLNA, convertido)`)
}

/** Chromecast: decide o transcode por codec (probe) e usa HLS ao vivo se precisar. */
async function startChromecast(args: CastStartArgs, probe: Probe, ip: string, onClose: () => void): Promise<void> {
  const transcode = needsTranscodeChromecast(probe)
  const ffmpegPath = transcode ? ((await resolveBinary('ffmpeg')) ?? undefined) : undefined
  if (transcode && !ffmpegPath)
    throw new Error('Vídeo incompatível com o Chromecast e ffmpeg não encontrado para transcodar.')
  if (transcode)
    logi(`Cast: vídeo ${probe.video}/${probe.audio} ${probe.channels}ch — transcodando pra H.264/AAC (HW)`)

  server = startCastServer({
    ip,
    videoPath: args.videoPath,
    subtitlePath: args.subtitlePath,
    transcode,
    ffmpegPath,
    durationSec: probe.durationSec,
    maxRamBytes: Math.max(0.1, args.ramGb || 0.5) * 1024 ** 3,
    mode: 'chromecast'
  })

  const cc = new CastConnection()
  conn = cc
  cc.onStatus = (st) => {
    // Preferimos a duração do ffprobe (real). Só usamos a do receiver se não
    // soubermos — no modo transcode (pipe ao vivo) a duração dele é falsa (cresce).
    const dur = Number((st.media as { duration?: number } | undefined)?.duration ?? 0)
    if (dur > 0 && lastDuration === 0) lastDuration = dur
    statusSink?.({
      device: deviceName,
      playerState: String(st.playerState ?? ''),
      currentTime: Number(st.currentTime ?? 0),
      duration: lastDuration
    })
  }
  cc.onClose = onClose

  await cc.open(args.deviceHost)
  await cc.launch()
  await cc.load({
    contentUrl: server.videoUrl,
    contentType: server.contentType,
    title: args.title,
    durationSec: probe.durationSec,
    subtitleUrl: server.subtitleUrl,
    subtitleLang: args.subtitleLang,
    subtitleLabel: args.subtitleLabel
  })
  logi(
    `Cast: reproduzindo "${args.title}"${server.subtitleUrl ? ' com legenda' : ''}${transcode ? ' (transcode)' : ''} em "${args.deviceName}"`
  )
}

export async function castControl(action: 'play' | 'pause' | 'stop' | 'seek', seconds = 0): Promise<void> {
  if (!conn) return
  try {
    if (action === 'play') await conn.play()
    else if (action === 'pause') await conn.pause()
    else if (action === 'seek') await conn.seek(seconds)
    else if (action === 'stop') await castStop()
  } catch (err) {
    loge(`Cast: falha no comando ${action}: ${(err as Error).message}`)
  }
}

export async function castStop(): Promise<void> {
  if (conn) {
    try {
      await conn.stop()
    } catch {
      // pode não haver mídia — ignora
    }
    conn.close()
    conn = null
  }
  server?.stop()
  server = null
  dlnaTmp?.stop() // mata o pré-transcode em andamento + apaga o temporário
  dlnaTmp = null
  if (deviceName) {
    statusSink?.({ device: deviceName, playerState: 'STOPPED', currentTime: 0, duration: 0 })
    deviceName = ''
  }
}
