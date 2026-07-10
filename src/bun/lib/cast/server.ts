// Servidor HTTP local pra o Chromecast puxar o vídeo e a legenda da LAN.
// - Vídeo: suporta byte-range (206) pra permitir seek.
// - Legenda: convertida pra WebVTT (o Cast só aceita VTT) e servida com CORS
//   (o Default Media Receiver busca a faixa por XHR e exige Access-Control).

import { extname } from '../paths'

export interface CastServer {
  /** URL do vídeo na LAN (http://ip:porta/video). */
  videoUrl: string
  /** URL da legenda VTT, se houver. */
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

/**
 * Sobe o servidor de mídia. Serve `videoPath` (com range) e, se dado,
 * `subtitlePath` (.srt convertido pra VTT). Retorna as URLs e um `stop()`.
 */
export function startCastServer(opts: {
  ip: string
  videoPath: string
  subtitlePath?: string
  port?: number
}): CastServer {
  const mime = videoMime(opts.videoPath)

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: '0.0.0.0',
    async fetch(req) {
      const { pathname } = new URL(req.url)

      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

      if (pathname === '/video') {
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
    stop: () => server.stop(true)
  }
}
