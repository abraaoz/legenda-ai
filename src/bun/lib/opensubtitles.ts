import type {
  DownloadResult,
  SubtitleResult,
  ValidateResult,
  VideoInfo
} from '../../shared/types'
import { hasFfmpeg, listEmbeddedSubtitles } from './ffmpeg'
import { findExternalSubtitles } from './files'
import { logd, logi } from './logger'
import { hasOcr } from './ocr'
import { basename, dirname, extname, joinPath } from './paths'
import { canonicalLang } from '../../shared/lang'
import { version } from '../../shared/version'

const API_BASE = 'https://api.opensubtitles.com/api/v1'
// Deve ser o nome EXATO do consumer registrado no OpenSubtitles + versão,
// senão a API retorna 403 "User-Agent header is wrong". Validação é pelo NOME;
// a versão vem do package.json (fonte única, via shared/version).
const USER_AGENT = `legendaAIpramim v${version}`
const HASH_CHUNK_SIZE = 65536 // 64 KiB lidos no início e no fim do arquivo
const U64_MASK = 0xffffffffffffffffn

function headers(apiKey: string): Record<string, string> {
  return {
    'Api-Key': apiKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': USER_AGENT
  }
}

/**
 * Hash do OpenSubtitles: soma de 64 bits do tamanho do arquivo com os primeiros
 * e últimos 64 KiB interpretados como uint64 little-endian. Lê apenas os dois
 * trechos via Bun.file().slice() — nunca carrega o vídeo inteiro na memória.
 */
export async function computeOpenSubtitlesHash(path: string, size: number): Promise<string> {
  if (size < HASH_CHUNK_SIZE * 2) {
    throw new Error('Arquivo muito pequeno para calcular o hash do OpenSubtitles.')
  }

  const file = Bun.file(path)
  const head = new DataView(await file.slice(0, HASH_CHUNK_SIZE).arrayBuffer())
  const tail = new DataView(await file.slice(size - HASH_CHUNK_SIZE, size).arrayBuffer())

  let hash = BigInt(size) & U64_MASK
  for (let i = 0; i < HASH_CHUNK_SIZE; i += 8) {
    hash = (hash + head.getBigUint64(i, true)) & U64_MASK
    hash = (hash + tail.getBigUint64(i, true)) & U64_MASK
  }
  return hash.toString(16).padStart(16, '0')
}

/** Lê o arquivo do disco e produz o VideoInfo (hash, tamanho, legendas embutidas). */
export async function analyzeVideo(path: string): Promise<VideoInfo> {
  logd(`Analisando arquivo: ${path}`)
  const size = Bun.file(path).size
  if (!size) throw new Error(`Não foi possível ler o arquivo: ${path}`)
  const hash = await computeOpenSubtitlesHash(path, size)
  const ffmpegAvailable = await hasFfmpeg()
  const embedded = ffmpegAvailable ? await listEmbeddedSubtitles(path) : []
  const external = await findExternalSubtitles(path)
  const ocrAvailable = await hasOcr()
  logi(
    `hash=${hash} · ${(size / 1024 ** 2).toFixed(0)} MB · ${embedded.length} embutida(s) · ${external.length} .srt externa(s)`
  )
  return { path, name: basename(path), size, hash, embedded, external, ffmpegAvailable, ocrAvailable }
}

/**
 * Valida a chave batendo no endpoint /subtitles (que REALMENTE checa a chave —
 * /infos/languages responde 200 para qualquer valor). Também detecta o erro
 * comum de colar a URL da página de consumers em vez da API Key.
 */
export async function validateApiKey(apiKey: string): Promise<ValidateResult> {
  const key = apiKey.trim()
  if (!key) return { valid: false, message: 'Informe uma chave primeiro.' }
  if (/\s|https?:|\//i.test(key)) {
    return {
      valid: false,
      message: 'Isso parece um link/URL — cole a API Key (a string) da página Consumers, não o link.'
    }
  }
  try {
    const url = new URL(`${API_BASE}/subtitles`)
    url.searchParams.set('languages', 'en')
    url.searchParams.set('moviehash', '0000000000000000')
    url.searchParams.sort()
    const res = await fetch(url, { headers: headers(key) })
    if (res.ok) return { valid: true, message: 'Chave válida ✅' }
    if (res.status === 403) {
      return {
        valid: false,
        message: 'Chave rejeitada (403). Confirme que colou a API Key correta do seu consumer.'
      }
    }
    if (res.status === 401) return { valid: false, message: 'Chave inválida ou não autorizada.' }
    return { valid: false, message: `Não foi possível validar (HTTP ${res.status}).` }
  } catch (err) {
    return { valid: false, message: `Erro de rede: ${(err as Error).message}` }
  }
}

interface RawSubtitle {
  attributes: {
    language: string
    release: string
    download_count: number
    ratings: number
    moviehash_match?: boolean
    feature_details?: { movie_name?: string; title?: string }
    files: Array<{ file_id: number; file_name: string }>
  }
}

/**
 * Busca legendas para o vídeo enviando o hash (sincronia exata) e o nome do
 * arquivo como fallback. Ordena os matches por hash primeiro, depois por downloads.
 */
export async function searchSubtitles(
  apiKey: string,
  video: VideoInfo,
  language: string
): Promise<SubtitleResult[]> {
  if (!apiKey) {
    throw new Error(
      'Configure sua chave da API do OpenSubtitles nas configurações antes de buscar.'
    )
  }

  // Busca APENAS por hash do vídeo (correspondência exata de sincronia).
  const url = new URL(`${API_BASE}/subtitles`)
  url.searchParams.set('languages', language.toLowerCase())
  url.searchParams.set('moviehash', video.hash.toLowerCase())
  // O OpenSubtitles EXIGE os parâmetros em ordem alfabética; caso contrário
  // responde 301 para a URL ordenada, e o fetch perde os headers no redirect
  // (resultando em 403 "You cannot consume this service").
  url.searchParams.sort()

  logd(`OpenSubtitles GET ${url.toString()}`)
  const res = await fetch(url, { headers: headers(apiKey) })
  if (!res.ok) {
    throw new Error(`Falha na busca (${res.status}): ${await res.text()}`)
  }

  const body = (await res.json()) as { data?: RawSubtitle[] }
  const items = body.data ?? []
  logi(`OpenSubtitles retornou ${items.length} resultado(s)`)

  return items
    .map((item): SubtitleResult => {
      const a = item.attributes
      const file = a.files[0]
      return {
        fileId: file?.file_id ?? -1,
        fileName: file?.file_name ?? `${a.release || 'legenda'}.srt`,
        language: a.language,
        release: a.release,
        downloadCount: a.download_count,
        ratings: a.ratings,
        movieName: a.feature_details?.movie_name ?? a.feature_details?.title ?? '',
        fromHashMatch: Boolean(a.moviehash_match)
      }
    })
    .filter((r) => r.fileId > 0)
    .sort((x, y) => {
      if (x.fromHashMatch !== y.fromHashMatch) return x.fromHashMatch ? -1 : 1
      return y.downloadCount - x.downloadCount
    })
}

/**
 * Efetiva o download: pede o link temporário à API, baixa o conteúdo e salva
 * ao lado do vídeo como "<nome>.<idioma>.<ext>".
 */
export async function downloadSubtitle(
  apiKey: string,
  video: VideoInfo,
  result: SubtitleResult
): Promise<DownloadResult> {
  if (!apiKey) {
    throw new Error('Configure sua chave da API do OpenSubtitles nas configurações.')
  }

  const linkRes = await fetch(`${API_BASE}/download`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ file_id: result.fileId })
  })
  if (!linkRes.ok) {
    throw new Error(`Falha ao gerar o download (${linkRes.status}): ${await linkRes.text()}`)
  }

  const { link } = (await linkRes.json()) as { link?: string }
  if (!link) throw new Error('A API não retornou um link de download.')

  logd(`Baixando legenda de ${link}`)
  const fileRes = await fetch(link)
  if (!fileRes.ok) throw new Error(`Falha ao baixar a legenda (${fileRes.status}).`)

  const ext = extname(result.fileName) || '.srt'
  const base = basename(video.path, extname(video.path))
  // canoniza o código da API (ex.: "pt-br" → "pt-BR") pro sufixo do arquivo
  const savedPath = joinPath(dirname(video.path), `${base}.${canonicalLang(result.language)}${ext}`)

  // Bun.write aceita a Response diretamente e grava o corpo em disco.
  await Bun.write(savedPath, fileRes)
  logi(`Legenda salva: ${savedPath}`)

  return { savedPath }
}
