import type { DownloadResult, EmbeddedSubtitle } from '../../shared/types'
import { logd, logi } from './logger'
import { basename, dirname, extname, joinPath } from './paths'
import { canonicalLang } from '../../shared/lang'

// Diretórios comuns onde ffmpeg/ffprobe ficam quando o PATH do app é mínimo
// (caso típico de um .app aberto pelo Finder no macOS).
const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/snap/bin']

const resolved = new Map<string, string | null>()

/** Limpa o cache de resolução (usado ao reverificar dependências). */
export function clearBinaryCache(): void {
  resolved.clear()
}

/**
 * Encontra o caminho absoluto de um binário (ffmpeg/ffprobe), com cache.
 * Procura no PATH e em diretórios comuns — mais robusto que `which`, que num
 * app aberto pelo Finder não enxerga /opt/homebrew/bin e afins.
 */
export async function resolveBinary(name: string): Promise<string | null> {
  if (resolved.has(name)) return resolved.get(name)!

  const isWin = process.platform === 'win32'
  const exe = isWin ? `${name}.exe` : name
  const pathDirs = (process.env.PATH ?? '').split(isWin ? ';' : ':')

  for (const dir of [...pathDirs, ...EXTRA_DIRS]) {
    if (!dir) continue
    const candidate = joinPath(dir, exe)
    if (await Bun.file(candidate).exists()) {
      resolved.set(name, candidate)
      return candidate
    }
  }
  resolved.set(name, null)
  return null
}

export async function hasFfmpeg(): Promise<boolean> {
  return (await resolveBinary('ffprobe')) !== null
}

// Codecs de legenda baseados em TEXTO (extraíveis para .srt e traduzíveis).
// Fora desta lista (ex.: hdmv_pgs_subtitle, dvd_subtitle) é imagem → requer OCR.
const TEXT_SUB_CODECS = new Set([
  'subrip',
  'srt',
  'ass',
  'ssa',
  'mov_text',
  'webvtt',
  'vtt',
  'text',
  'subviewer',
  'microdvd',
  'stl'
])

interface ProbeStream {
  index: number
  codec_name?: string
  tags?: { language?: string; title?: string }
  disposition?: { default?: number; forced?: number }
}

/** Lista as faixas de legenda embutidas no arquivo via ffprobe. */
export async function listEmbeddedSubtitles(path: string): Promise<EmbeddedSubtitle[]> {
  const ffprobe = await resolveBinary('ffprobe')
  if (!ffprobe) return []

  logd(`ffprobe (legendas) em ${path}`)
  const proc = Bun.spawn(
    [ffprobe, '-v', 'error', '-select_streams', 's', '-show_streams', '-of', 'json', path],
    { stdout: 'pipe', stderr: 'ignore' }
  )
  const out = await new Response(proc.stdout).text()
  await proc.exited

  try {
    const data = JSON.parse(out) as { streams?: ProbeStream[] }
    return (data.streams ?? []).map((s) => ({
      index: s.index,
      language: s.tags?.language ?? 'und',
      title: s.tags?.title ?? '',
      codec: s.codec_name ?? '',
      isText: TEXT_SUB_CODECS.has((s.codec_name ?? '').toLowerCase()),
      isDefault: s.disposition?.default === 1,
      isForced: s.disposition?.forced === 1
    }))
  } catch {
    return []
  }
}

/**
 * Extrai uma faixa de legenda embutida para um .srt ao lado do vídeo.
 * A legenda embutida já vem 100% sincronizada com o vídeo.
 */
export async function extractEmbedded(
  path: string,
  index: number,
  language: string,
  isText = true
): Promise<DownloadResult> {
  const ffmpeg = await resolveBinary('ffmpeg')
  if (!ffmpeg) throw new Error('ffmpeg não encontrado na máquina.')

  const base = basename(path, extname(path))
  // canoniza o código da faixa pro sufixo (ffprobe dá "eng" → arquivo `.en.srt`)
  const lang = language && language !== 'und' ? canonicalLang(language) : `faixa${index}`
  // Texto → converte para .srt; imagem (PGS/VobSub) → copia bruto para .sup.
  const ext = isText ? 'srt' : 'sup'
  const codecArgs = isText ? ['-c:s', 'srt'] : ['-c:s', 'copy']
  const savedPath = joinPath(dirname(path), `${base}.${lang}.${ext}`)

  logi(`ffmpeg: extraindo faixa ${index} (${isText ? 'texto' : 'imagem'}) → ${savedPath}`)
  const proc = Bun.spawn([ffmpeg, '-y', '-i', path, '-map', `0:${index}`, ...codecArgs, savedPath], {
    stdout: 'ignore',
    stderr: 'pipe'
  })
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) {
    const tail = err.split('\n').slice(-3).join(' ').trim()
    if (isText && /only possible|Invalid argument|bitmap/i.test(err)) {
      throw new Error('Esta legenda é em imagem (PGS/VobSub) e não pode virar texto — requer OCR.')
    }
    throw new Error(`Falha ao extrair (ffmpeg): ${tail}`)
  }
  logi(`Legenda embutida extraída: ${savedPath}`)
  return { savedPath }
}

/** Extrai a faixa como SRT para memória (sem escrever arquivo) — usado para contar falas. */
export async function extractEmbeddedToString(path: string, index: number): Promise<string> {
  const ffmpeg = await resolveBinary('ffmpeg')
  if (!ffmpeg) throw new Error('ffmpeg não encontrado na máquina.')
  const proc = Bun.spawn(
    [ffmpeg, '-v', 'error', '-i', path, '-map', `0:${index}`, '-c:s', 'srt', '-f', 'srt', 'pipe:1'],
    { stdout: 'pipe', stderr: 'ignore' }
  )
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}
