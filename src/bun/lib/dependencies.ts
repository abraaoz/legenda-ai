import type { DependencyStatus } from '../../shared/types'
import { clearBinaryCache, resolveBinary } from './ffmpeg'
import { logi } from './logger'
import { listModels } from './ollama'
import { hasVision } from './vision'
import { hasWinOcr } from './winocr'
import { hasAppleTranslate } from './apple'
import { joinPath } from './paths'
import { getSettings } from './settings'

const INSTALL_HINT = process.platform === 'darwin' ? 'instale com: brew install ffmpeg' : 'instale o ffmpeg'

/** Teste funcional de escrita em disco — a "permissão" que importa: salvar .srt. */
async function checkDiskWrite(): Promise<DependencyStatus> {
  const tmpDir = process.env.TMPDIR ?? process.env.TEMP ?? '/tmp'
  const tmp = joinPath(tmpDir, 'legenda-perm-check.tmp')
  try {
    await Bun.write(tmp, 'ok')
    const back = await Bun.file(tmp).text()
    if (back !== 'ok') throw new Error('leitura divergente')
    return {
      name: 'Gravação em disco',
      found: true,
      detail: `escrita/leitura OK (${tmpDir})`,
      purpose: 'Salvar os .srt baixados/extraídos/traduzidos'
    }
  } catch (err) {
    return {
      name: 'Gravação em disco',
      found: false,
      detail: `falhou: ${(err as Error).message}`,
      purpose: 'Salvar os .srt baixados/extraídos/traduzidos'
    }
  }
}

/**
 * Verifica as dependências externas por caminho absoluto (ffmpeg/ffprobe), via
 * HTTP (Ollama) e a capacidade de escrita. Não usa `which` — o PATH de um app
 * aberto pelo Finder é mínimo. O app não precisa de Accessibility.
 */
export async function checkDependencies(): Promise<DependencyStatus[]> {
  logi('Verificando dependências externas…')
  clearBinaryCache()

  const ffprobe = await resolveBinary('ffprobe')
  const ffmpeg = await resolveBinary('ffmpeg')
  const tesseract = await resolveBinary('tesseract')
  const vision = await hasVision()
  const winOcr = await hasWinOcr()
  const appleTranslate = await hasAppleTranslate()

  const settings = await getSettings()
  const ollama = await listModels(settings.ollamaUrl)

  const disk = await checkDiskWrite()

  const azureConfigured = Boolean(settings.azureKey && settings.azureRegion)
  const azure: DependencyStatus = {
    name: 'Azure Translator',
    found: azureConfigured,
    detail: azureConfigured
      ? `configurado (região ${settings.azureRegion})`
      : 'sem credenciais — opcional (tradução na nuvem)',
    purpose: 'Tradução de legendas (Azure)'
  }

  return [
    {
      name: 'ffprobe',
      found: ffprobe !== null,
      detail: ffprobe ?? `não encontrado — ${INSTALL_HINT}`,
      purpose: 'Detectar legendas embutidas no vídeo'
    },
    {
      name: 'ffmpeg',
      found: ffmpeg !== null,
      detail: ffmpeg ?? `não encontrado — ${INSTALL_HINT}`,
      purpose: 'Extrair/traduzir legendas embutidas'
    },
    {
      name: 'Vision (macOS)',
      found: vision,
      detail: vision
        ? 'OCR nativo do macOS — engine padrão (melhor qualidade)'
        : process.platform === 'darwin'
          ? 'indisponível (precisa do swiftc / Xcode CLT)'
          : 'só no macOS',
      purpose: 'OCR de legendas em imagem (PGS/Blu-ray)'
    },
    {
      name: 'Windows OCR',
      found: winOcr,
      detail: winOcr
        ? 'OCR nativo do Windows (Windows.Media.Ocr) — engine padrão no Windows'
        : process.platform === 'win32'
          ? 'indisponível'
          : 'só no Windows',
      purpose: 'OCR de legendas em imagem (PGS/Blu-ray)'
    },
    {
      name: 'Tesseract',
      found: tesseract !== null,
      detail: tesseract
        ? `${tesseract}${vision || winOcr ? ' — fallback' : ''}`
        : 'não encontrado — fallback de OCR (Linux, ou sem engine nativo)',
      purpose: 'OCR de legendas em imagem (fallback / Linux)'
    },
    {
      name: 'Ollama',
      found: ollama.available,
      detail: ollama.available
        ? `${ollama.models.length} modelo(s) em ${settings.ollamaUrl}`
        : `servidor não respondeu em ${settings.ollamaUrl} — instale em ollama.com`,
      purpose: 'Tradução local de legendas'
    },
    {
      name: 'Apple Translation (macOS)',
      found: appleTranslate,
      detail: appleTranslate
        ? 'tradução on-device do macOS — offline, grátis, sem limite de taxa'
        : process.platform === 'darwin'
          ? 'indisponível (requer macOS 15+ e swiftc / Xcode CLT)'
          : 'só no macOS',
      purpose: 'Tradução de legendas (Apple, on-device)'
    },
    azure,
    disk
  ]
}
