// Orquestra o "Tocar na TV": descoberta + servidor de mídia + conexão CASTV2.
// Mantém UMA sessão ativa por vez (trocar de vídeo/TV encerra a anterior).

import type { CastDevice, CastPlaybackStatus, CastStartArgs } from '../../../shared/types'
import { logi, loge } from '../logger'
import { discoverCastDevices, localIp } from './discover'
import { CastConnection } from './client'
import { startCastServer, videoMime, type CastServer } from './server'

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
  const ip = await localIp(args.deviceHost)
  logi(`Cast: servindo mídia em ${ip} para "${args.deviceName}" (${args.deviceHost})`)
  server = startCastServer({ ip, videoPath: args.videoPath, subtitlePath: args.subtitlePath })

  conn = new CastConnection()
  conn.onStatus = (st) => {
    const dur = Number((st.media as { duration?: number } | undefined)?.duration ?? 0)
    if (dur > 0) lastDuration = dur
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
    contentType: videoMime(args.videoPath),
    title: args.title,
    subtitleUrl: server.subtitleUrl,
    subtitleLang: args.subtitleLang,
    subtitleLabel: args.subtitleLabel
  })
  logi(`Cast: reproduzindo "${args.title}"${server.subtitleUrl ? ' com legenda' : ''} em "${args.deviceName}"`)
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
