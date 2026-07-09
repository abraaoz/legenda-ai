import { resolveBinary } from './ffmpeg'
import { logi } from './logger'
import { basename, dirname, extname, joinPath } from './paths'
import { parsePgs, type SubtitleImage } from './pgs'
import { type Cue, parseSrt, serializeSrt } from './srt'
import { hasVision, resolveVisionOcr, visionLang, visionOcrChunk } from './vision'
import { hasWinOcr, resolveWinOcr, winLang, winOcrChunk } from './winocr'

// Códigos ISO 639-2 das faixas → códigos de idioma do Tesseract.
const TESS_LANG: Record<string, string> = {
  eng: 'eng',
  por: 'por',
  spa: 'spa',
  fre: 'fra',
  fra: 'fra',
  ger: 'deu',
  deu: 'deu',
  ita: 'ita',
  jpn: 'jpn'
}

export async function hasTesseract(): Promise<boolean> {
  return (await resolveBinary('tesseract')) !== null
}

/** OCR disponível por qualquer engine (Vision no macOS, Windows.Media.Ocr, ou Tesseract). */
export async function hasOcr(): Promise<boolean> {
  return (await hasVision()) || (await hasWinOcr()) || (await hasTesseract())
}

async function availableLangs(tesseract: string): Promise<Set<string>> {
  const proc = Bun.spawn([tesseract, '--list-langs'], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return new Set(
    out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.toLowerCase().startsWith('list of'))
  )
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}
function msToTs(ms: number): string {
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}
/** Início (ms) de uma linha de tempo SRT "HH:MM:SS,mmm --> ...". */
function tsToMs(timeLine: string): number {
  const m = timeLine.match(/(\d+):(\d+):(\d+)[,.](\d+)/)
  if (!m) return -1
  return +m[1] * 3600000 + +m[2] * 60000 + +m[3] * 1000 + +m[4]
}

async function removeFile(path: string): Promise<void> {
  try {
    await Bun.$`rm -f ${path}`.quiet().nothrow()
  } catch {
    // ignora
  }
}

/** Marcador que indica um OCR incompleto (para retomada). */
export function ocrMarkerPath(srtPath: string): string {
  return `${srtPath}.part`
}

/** Fator de ampliação da imagem antes do OCR (Tesseract acerta mais em texto
 * maior). 2.0 é o ponto ótimo aqui; fatores maiores/fracionários viram empate
 * (trocam um erro por outro) com nearest-neighbor. Aceita valor fracionário. */
const OCR_UPSCALE = 2

/** Amplia por um fator qualquer (inteiro ou fracionário) via amostragem por razão. */
function upscale(img: SubtitleImage, factor: number): SubtitleImage {
  if (factor <= 1) return img
  const sw = img.width
  const sh = img.height
  const w = Math.round(sw * factor)
  const h = Math.round(sh * factor)
  const gray = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, ((y * sh) / h) | 0)
    for (let x = 0; x < w; x++) {
      gray[y * w + x] = img.gray[sy * sw + Math.min(sw - 1, ((x * sw) / w) | 0)]
    }
  }
  return { ...img, width: w, height: h, gray }
}

function toPgm(img: SubtitleImage): Uint8Array {
  const header = `P5\n${img.width} ${img.height}\n255\n`
  const buf = new Uint8Array(header.length + img.gray.length)
  for (let i = 0; i < header.length; i++) buf[i] = header.charCodeAt(i)
  buf.set(img.gray, header.length)
  return buf
}

/** Corrige artefatos comuns do OCR de legendas (ex.: "I" lido como "|"). */
export function cleanOcrText(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*[|¦]\s+/, 'I ') // "| palavra" no início → "I palavra"
        .replace(/\s[|¦]\s/g, ' I ') // " | " no meio → " I "
        .replace(/[|¦]/g, 'I') // sobras de "|" → "I"
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
    )
    .filter((l) => l.length > 0)
    .join('\n')
}

/** Engine de OCR: recebe um lote de imagens e devolve o texto de cada uma. */
type OcrChunk = (images: SubtitleImage[], tmpBase: string) => Promise<string[]>

/**
 * OCR de uma faixa PGS (legenda em imagem) → .srt no idioma da faixa. No macOS
 * usa o Vision (melhor e rápido em lote); senão o Tesseract (upscale 2x +
 * limpeza). Extrai o .sup (cacheado), monta o SRT com os timestamps originais,
 * grava incrementalmente e é retomável. Salva "<nome>.<idioma>.srt".
 */
export async function ocrPgsToSrt(
  videoPath: string,
  index: number,
  language: string,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<string> {
  const ffmpeg = await resolveBinary('ffmpeg')
  if (!ffmpeg) throw new Error('ffmpeg não encontrado.')

  // Escolhe o engine: Vision (macOS) / Windows.Media.Ocr (Windows) por padrão;
  // Tesseract de fallback (Linux, ou quando o nativo não está disponível).
  const visionBin = await resolveVisionOcr()
  const winScript = await resolveWinOcr()
  let engineLabel: string
  let ocrChunk: OcrChunk
  let chunkSize: number

  if (visionBin) {
    const vLang = visionLang(language)
    engineLabel = `Vision ${vLang}`
    chunkSize = 20
    ocrChunk = (imgs, tmpBase) => visionOcrChunk(visionBin, vLang, imgs, tmpBase)
  } else if (winScript) {
    const wLang = winLang(language)
    engineLabel = `Windows OCR ${wLang}`
    chunkSize = 20
    ocrChunk = (imgs, tmpBase) => winOcrChunk(winScript, wLang, imgs, tmpBase)
  } else {
    const tesseract = await resolveBinary('tesseract')
    if (!tesseract) {
      throw new Error('Nenhum OCR disponível: instale o Tesseract (brew install tesseract).')
    }
    const tLang = TESS_LANG[language.toLowerCase()] ?? 'eng'
    const langs = await availableLangs(tesseract)
    if (!langs.has(tLang)) {
      throw new Error(`Idioma "${tLang}" do Tesseract não instalado. Rode: brew install tesseract-lang`)
    }
    engineLabel = `Tesseract ${tLang}`
    chunkSize = 8
    ocrChunk = async (imgs, tmpBase) => {
      const pgm = `${tmpBase}.pgm`
      const out: string[] = []
      for (const img of imgs) {
        await Bun.write(pgm, toPgm(upscale(img, OCR_UPSCALE)))
        const proc = Bun.spawn([tesseract, pgm, 'stdout', '-l', tLang, '--psm', '6'], {
          stdout: 'pipe',
          stderr: 'ignore'
        })
        out.push(cleanOcrText((await new Response(proc.stdout).text()).trim()))
        await proc.exited
      }
      return out
    }
  }

  const srtPath = joinPath(
    dirname(videoPath),
    `${basename(videoPath, extname(videoPath))}.${language}.srt`
  )
  const markerPath = ocrMarkerPath(srtPath)

  // 1. extrai o .sup (cacheado no tmp — a extração varre o container e é lenta)
  const size = Bun.file(videoPath).size
  const tmpDir = process.env.TMPDIR ?? '/tmp'
  const supPath = joinPath(tmpDir, `legenda-ocr-${size}-${index}.sup`)
  const tmpBase = joinPath(tmpDir, `legenda-ocr-${size}-${index}`)
  if (!(await Bun.file(supPath).exists()) || Bun.file(supPath).size === 0) {
    logi('OCR: extraindo a faixa PGS do vídeo (pode levar um pouco)…')
    const ex = Bun.spawn(
      [ffmpeg, '-y', '-v', 'error', '-i', videoPath, '-map', `0:${index}`, '-c:s', 'copy', supPath],
      { stdout: 'ignore', stderr: 'pipe' }
    )
    if ((await ex.exited) !== 0) throw new Error('Falha ao extrair a faixa PGS do vídeo.')
  } else {
    logi('OCR: reusando o .sup já extraído')
  }

  const images = parsePgs(new Uint8Array(await Bun.file(supPath).arrayBuffer()))

  // 2. retoma de um .srt parcial existente (alinha pela primeira imagem não feita)
  const cues: Cue[] = []
  if (await Bun.file(srtPath).exists()) {
    cues.push(...parseSrt(await Bun.file(srtPath).text()))
  }
  const lastMs = cues.length ? tsToMs(cues[cues.length - 1].time) : -1
  let start = images.findIndex((img) => img.startMs > lastMs)
  if (start < 0) start = images.length

  onProgress(start, images.length)
  if (start >= images.length) {
    await removeFile(markerPath) // já estava completo
    logi(`OCR já completo (${cues.length} falas): ${srtPath}`)
    return srtPath
  }

  logi(
    `OCR ${start > 0 ? `retomando da imagem ${start + 1}` : 'iniciando'} de ${images.length} (${engineLabel})`
  )
  await Bun.write(markerPath, String(images.length)) // marca "incompleto"

  // 3. processa em lotes (o Vision amortiza a carga do framework)
  let k = start
  for (; k < images.length; k += chunkSize) {
    if (signal?.aborted) break
    const batch = images.slice(k, k + chunkSize)
    const texts = await ocrChunk(batch, tmpBase)
    batch.forEach((img, j) => {
      const text = (texts[j] ?? '').trim()
      if (text) cues.push({ time: `${msToTs(img.startMs)} --> ${msToTs(img.endMs)}`, text })
    })
    await Bun.write(srtPath, serializeSrt(cues)) // gravação incremental
    onProgress(Math.min(k + chunkSize, images.length), images.length)
  }

  if (k < images.length) {
    // cancelado no meio — mantém o parcial + marcador para retomar depois
    throw new Error('Tradução cancelada.')
  }
  await removeFile(markerPath) // completo
  logi(`OCR concluído (${engineLabel}): ${cues.length} falas → ${srtPath}`)
  return srtPath
}
