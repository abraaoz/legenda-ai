// Servidor HTTP local pra o Chromecast puxar o vídeo e a legenda da LAN.
// - Vídeo compatível (H.264): servido cru com byte-range (206) pra permitir seek.
// - Vídeo incompatível (HEVC/x265, áudio multicanal…): TRANSCODE on-the-fly pra
//   H.264 + AAC estéreo via ffmpeg (encoder de HW VideoToolbox no macOS), servido
//   como fMP4 progressivo. Sem seek nesse modo (é um pipe ao vivo).
// - Legenda: convertida pra WebVTT (o Cast só aceita VTT) e servida com CORS.

import type { Subprocess } from 'bun'
import { extname } from '../paths'

export interface CastServer {
  videoUrl: string
  subtitleUrl?: string
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

/** Argumentos do ffmpeg pra transcodar pra H.264/AAC estéreo em fMP4 (pipe). */
function transcodeArgs(ffmpeg: string, videoPath: string, seekSec: number): string[] {
  return [
    ffmpeg,
    '-hide_banner',
    '-loglevel',
    'error',
    ...(seekSec > 0 ? ['-ss', String(seekSec)] : []),
    '-i',
    videoPath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-c:v',
    'h264_videotoolbox', // encoder de hardware do macOS
    '-b:v',
    '8M',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ac',
    '2', // downmix pra estéreo
    '-b:a',
    '192k',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof', // fMP4 stream-ável sem seek de saída
    '-f',
    'mp4',
    'pipe:1'
  ]
}

/**
 * Sobe o servidor de mídia. Se `transcode` + `ffmpegPath`, serve o vídeo
 * transcodado (H.264/AAC) via pipe do ffmpeg; senão, cru com byte-range.
 */
export function startCastServer(opts: {
  ip: string
  videoPath: string
  subtitlePath?: string
  transcode?: boolean
  ffmpegPath?: string
  port?: number
}): CastServer {
  const useTranscode = Boolean(opts.transcode && opts.ffmpegPath)
  const mime = useTranscode ? 'video/mp4' : videoMime(opts.videoPath)
  let ffmpegProc: Subprocess | null = null

  function killFfmpeg(): void {
    try {
      ffmpegProc?.kill()
    } catch {
      // ignora
    }
    ffmpegProc = null
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: '0.0.0.0',
    async fetch(req) {
      const { pathname } = new URL(req.url)

      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

      if (pathname === '/video') {
        if (useTranscode) {
          // Transcode ao vivo: um pipe do ffmpeg por requisição de mídia.
          killFfmpeg()
          const proc = Bun.spawn(transcodeArgs(opts.ffmpegPath!, opts.videoPath, 0), {
            stdout: 'pipe',
            stderr: 'ignore'
          })
          ffmpegProc = proc
          return new Response(proc.stdout as ReadableStream, {
            headers: { 'Content-Type': 'video/mp4', ...CORS }
          })
        }

        const file = Bun.file(opts.videoPath)
        const size = file.size
        const base = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', ...CORS }
        const range = req.headers.get('range')
        if (range) {
          const m = range.match(/bytes=(\d+)-(\d*)/)
          const start = m ? Number(m[1]) : 0
          const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
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
    videoUrl: `${origin}/video`,
    subtitleUrl: opts.subtitlePath ? `${origin}/subtitle.vtt` : undefined,
    port,
    stop: () => {
      killFfmpeg()
      server.stop(true)
    }
  }
}
