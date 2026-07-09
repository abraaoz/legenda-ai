import { logi } from './logger'
import { extname } from './paths'

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
