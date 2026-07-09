import type { ExternalSubtitle } from '../../shared/types'
import { logi } from './logger'
import { basename, dirname, extname, joinPath } from './paths'

const VIDEO_EXTS = new Set([
  '.mkv',
  '.mp4',
  '.avi',
  '.mov',
  '.m4v',
  '.wmv',
  '.flv',
  '.webm',
  '.mpg',
  '.mpeg',
  '.ts'
])

/**
 * Lista recursivamente todos os arquivos de vídeo dentro de uma pasta, usando
 * Bun.Glob (nativo do Bun). Retorna caminhos absolutos, ordenados.
 */
export async function listVideosInFolder(dir: string): Promise<string[]> {
  logi(`Varrendo pasta (recursivo): ${dir}`)
  const glob = new Bun.Glob('**/*')
  const files: string[] = []
  for await (const file of glob.scan({ cwd: dir, absolute: true, onlyFiles: true })) {
    if (VIDEO_EXTS.has(extname(file).toLowerCase())) files.push(file)
  }
  logi(`${files.length} vídeo(s) encontrado(s) na pasta`)
  return files.sort((a, b) => a.localeCompare(b))
}

/**
 * Encontra legendas .srt EXTERNAS ao lado do vídeo — arquivos com o mesmo
 * nome-base na mesma pasta (convenção dos players e do próprio app):
 *   Filme.mkv → Filme.srt, Filme.en.srt, Filme.pt-br.srt, Filme.pt-br.ai.srt …
 * Extrai o token de idioma do sufixo e marca as traduções do app (".ai.srt").
 */
export async function findExternalSubtitles(videoPath: string): Promise<ExternalSubtitle[]> {
  const dir = dirname(videoPath)
  const base = basename(videoPath, extname(videoPath)) // "Filme"
  const baseLc = base.toLowerCase()
  const found: ExternalSubtitle[] = []
  const glob = new Bun.Glob('*')
  for await (const name of glob.scan({ cwd: dir, absolute: false, onlyFiles: true })) {
    if (extname(name).toLowerCase() !== '.srt') continue
    const stem = name.slice(0, name.length - 4) // sem ".srt"
    const stemLc = stem.toLowerCase()
    // Só os que casam com o nome do vídeo: "Filme" ou "Filme.<sufixo>".
    if (stemLc !== baseLc && !stemLc.startsWith(baseLc + '.')) continue
    let suffix = stem.length === base.length ? '' : stem.slice(base.length + 1)
    let aiTranslated = false
    if (suffix.toLowerCase().endsWith('.ai')) {
      aiTranslated = true
      suffix = suffix.slice(0, -3)
    }
    found.push({
      path: joinPath(dir, name),
      name,
      size: Bun.file(joinPath(dir, name)).size,
      language: suffix,
      aiTranslated
    })
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}
