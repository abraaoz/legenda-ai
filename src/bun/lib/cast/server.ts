// Servidor HTTP local pra o Chromecast puxar o vídeo e a legenda da LAN.
// - Vídeo compatível (H.264): servido cru com byte-range (206) → seek nativo.
// - Vídeo incompatível (HEVC/x265, áudio multicanal…): transcode via **HLS** —
//   uma playlist VOD (.m3u8) que anuncia a duração inteira + segmentos .ts
//   transcodados SOB DEMANDA (ffmpeg com -ss/-t, decode+encode em HW no macOS).
//   Isso deixa o SEEK funcionar por qualquer controlador (Google Home, TV…),
//   porque cada ponto da barra vira um pedido de segmento independente.
// - Legenda: convertida pra WebVTT (o Cast só aceita VTT) e servida com CORS.

import type { Subprocess } from 'bun'
import { extname } from '../paths'

export interface CastServer {
  videoUrl: string
  subtitleUrl?: string
  /** MIME a declarar no LOAD (video/mp4, video/x-matroska ou application/x-mpegURL). */
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

/** SRT → WebVTT: cabeçalho WEBVTT + vírgula→ponto nos milissegundos dos tempos. */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^﻿/, '')
    .replace(/\r+/g, '')
    .replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2')
    .trim()
  return `WEBVTT\n\n${body}\n`
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }
const SEG = 6 // duração de cada segmento HLS (s)

/** Playlist HLS VOD com N segmentos de SEG segundos cobrindo a duração toda. */
function hlsPlaylist(durationSec: number, seg: number): string {
  const n = Math.max(1, Math.ceil(durationSec / seg))
  let out = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n'
  out += `#EXT-X-TARGETDURATION:${seg}\n#EXT-X-MEDIA-SEQUENCE:0\n`
  for (let i = 0; i < n; i++) {
    const d = i === n - 1 ? durationSec - i * seg : seg
    out += `#EXTINF:${(d > 0 ? d : seg).toFixed(3)},\nseg${i}.ts\n`
  }
  return out + '#EXT-X-ENDLIST\n'
}

/** ffmpeg pra transcodar UM segmento [start, start+dur] → MPEG-TS (pipe). */
function segmentArgs(ffmpeg: string, videoPath: string, start: number, dur: number): string[] {
  return [
    ffmpeg,
    '-hide_banner',
    '-loglevel',
    'error',
    '-hwaccel',
    'videotoolbox', // decode do HEVC em HW
    '-ss',
    String(start), // seek de entrada (rápido; accurate_seek liga por padrão)
    '-i',
    videoPath,
    '-t',
    String(dur),
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-c:v',
    'h264_videotoolbox', // encode em HW
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
    '192k',
    '-output_ts_offset',
    String(start), // PTS absoluto → o player sabe onde o segmento fica na linha do tempo
    '-muxdelay',
    '0',
    '-f',
    'mpegts',
    'pipe:1'
  ]
}

export function startCastServer(opts: {
  ip: string
  videoPath: string
  subtitlePath?: string
  transcode?: boolean
  ffmpegPath?: string
  durationSec?: number
  port?: number
}): CastServer {
  const useTranscode = Boolean(opts.transcode && opts.ffmpegPath)
  const rawMime = videoMime(opts.videoPath)
  const procs = new Set<Subprocess>()

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: '0.0.0.0',
    async fetch(req) {
      const { pathname } = new URL(req.url)
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

      // --- Modo transcode: HLS (playlist + segmentos on-demand) ---
      if (useTranscode) {
        if (pathname === '/index.m3u8') {
          return new Response(hlsPlaylist(opts.durationSec ?? 0, SEG), {
            headers: { 'Content-Type': 'application/x-mpegURL', ...CORS }
          })
        }
        const m = pathname.match(/^\/seg(\d+)\.ts$/)
        if (m) {
          const i = Number(m[1])
          const start = i * SEG
          const dur = Math.min(SEG, Math.max(1, (opts.durationSec ?? start + SEG) - start))
          const proc = Bun.spawn(segmentArgs(opts.ffmpegPath!, opts.videoPath, start, dur), {
            stdout: 'pipe',
            stderr: 'ignore'
          })
          procs.add(proc)
          proc.exited.then(() => procs.delete(proc))
          return new Response(proc.stdout as ReadableStream, {
            headers: { 'Content-Type': 'video/mp2t', ...CORS }
          })
        }
      }

      // --- Modo cru: vídeo compatível servido com byte-range ---
      if (pathname === '/video') {
        const file = Bun.file(opts.videoPath)
        const size = file.size
        const base = { 'Content-Type': rawMime, 'Accept-Ranges': 'bytes', ...CORS }
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
  return {
    videoUrl: useTranscode ? `${origin}/index.m3u8` : `${origin}/video`,
    subtitleUrl: opts.subtitlePath ? `${origin}/subtitle.vtt` : undefined,
    contentType: useTranscode ? 'application/x-mpegURL' : rawMime,
    port,
    stop: () => {
      for (const p of procs) {
        try {
          p.kill()
        } catch {
          // ignora
        }
      }
      procs.clear()
      server.stop(true)
    }
  }
}
