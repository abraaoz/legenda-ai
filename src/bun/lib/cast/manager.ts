// Orquestra o "Tocar na TV": descoberta + servidor de mídia + conexão CASTV2.
// Mantém UMA sessão ativa por vez (trocar de vídeo/TV encerra a anterior).

import type { CastDevice, CastPlaybackStatus, CastStartArgs } from '../../../shared/types'
import { resolveBinary } from '../ffmpeg'
import { logi, loge } from '../logger'
import { discoverCastDevices, localIp } from './discover'
import { CastConnection } from './client'
import { startCastServer, type CastServer } from './server'

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

/** Chromecast básico só toca H.264 + áudio comum estéreo. */
function needsTranscode(p: Probe): boolean {
  const okVideo = p.video === 'h264'
  const okAudio = ['aac', 'mp3', 'vorbis', 'opus'].includes(p.audio) && p.channels <= 2
  return !okVideo || !okAudio
}

let conn: CastConnection | null = null
let server: CastServer | null = null
let deviceName = ''
let lastDuration = 0
let statusSink: ((s: CastPlaybackStatus) => void) | null = null

export function setCastStatusSink(fn: (s: CastPlaybackStatus) => void): void {
  statusSink = fn
}

export async function castDiscover(): Promise<CastDevice[]> {
  return discoverCastDevices(3000)
}

/** Inicia (ou troca) a reprodução na TV. */
export async function castStart(args: CastStartArgs): Promise<void> {
  await castStop()
  deviceName = args.deviceName
  lastDuration = 0

  // Decide se precisa transcodar (HEVC/x265, áudio multicanal… → Chromecast não toca).
  const probe = await probeVideo(args.videoPath)
  const transcode = needsTranscode(probe)
  lastDuration = probe.durationSec
  const ffmpegPath = transcode ? ((await resolveBinary('ffmpeg')) ?? undefined) : undefined
  if (transcode && !ffmpegPath) throw new Error('Vídeo incompatível com o Chromecast e ffmpeg não encontrado para transcodar.')
  if (transcode) {
    logi(`Cast: vídeo ${probe.video}/${probe.audio} ${probe.channels}ch — transcodando pra H.264/AAC (HW)`)
  }

  const ip = await localIp(args.deviceHost)
  logi(`Cast: servindo mídia em ${ip} para "${args.deviceName}" (${args.deviceHost})`)
  server = startCastServer({
    ip,
    videoPath: args.videoPath,
    subtitlePath: args.subtitlePath,
    transcode,
    ffmpegPath,
    durationSec: probe.durationSec
  })

  conn = new CastConnection()
  conn.onStatus = (st) => {
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
  conn.onClose = () => {
    statusSink?.({ device: deviceName, playerState: 'STOPPED', currentTime: 0, duration: 0 })
  }

  await conn.open(args.deviceHost)
  await conn.launch()
  await conn.load({
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
  if (deviceName) {
    statusSink?.({ device: deviceName, playerState: 'STOPPED', currentTime: 0, duration: 0 })
    deviceName = ''
  }
}
