import { resolveBinary } from './ffmpeg'
import { logi, logw } from './logger'
import { basename, dirname, extname, joinPath } from './paths'
import { canonicalLang } from '../../shared/lang'
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

/** Codec da faixa de legenda `index` (via ffprobe). Distingue PGS de VobSub. */
async function subtitleCodec(videoPath: string, index: number): Promise<string> {
  const ffprobe = await resolveBinary('ffprobe')
  if (!ffprobe) return ''
  const proc = Bun.spawn(
    [ffprobe, '-v', 'error', '-select_streams', String(index), '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', videoPath],
    { stdout: 'pipe', stderr: 'ignore' }
  )
  const out = (await new Response(proc.stdout).text()).trim()
  await proc.exited
  return out
}

/**
 * OCR de uma faixa de legenda EM IMAGEM → .srt no idioma da faixa. Despacha por
 * codec: **PGS** (Blu-ray, `.sup`) usa o parser próprio; **VobSub** (DVD,
 * `dvd_subtitle`) é renderizado pelo ffmpeg. Ambos caem no mesmo core de OCR.
 */
export async function ocrImageToSrt(
  videoPath: string,
  index: number,
  language: string,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<string> {
  const codec = (await subtitleCodec(videoPath, index)).toLowerCase()
  const images =
    codec === 'dvd_subtitle' || codec === 'dvdsub'
      ? await renderVobsubImages(videoPath, index, signal)
      : await extractPgsImages(videoPath, index)
  return ocrImagesToSrt(videoPath, index, language, images, onProgress, signal)
}

/** Compat: OCR de PGS (mantém o nome usado em outros lugares). */
export async function ocrPgsToSrt(
  videoPath: string,
  index: number,
  language: string,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<string> {
  return ocrImageToSrt(videoPath, index, language, onProgress, signal)
}

/** Extrai o .sup (cacheado) e decodifica os bitmaps PGS com seus timestamps. */
async function extractPgsImages(videoPath: string, index: number): Promise<SubtitleImage[]> {
  const ffmpeg = await resolveBinary('ffmpeg')
  if (!ffmpeg) throw new Error('ffmpeg não encontrado.')
  const size = Bun.file(videoPath).size
  const tmpDir = process.env.TMPDIR ?? '/tmp'
  const supPath = joinPath(tmpDir, `legenda-ocr-${size}-${index}.sup`)
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
  return parsePgs(new Uint8Array(await Bun.file(supPath).arrayBuffer()))
}

/**
 * Renderiza uma faixa VobSub (`dvd_subtitle`) em imagens OCR-ready. O ffmpeg
 * não converte VobSub→texto nem →PGS, mas DECODIFICA os bitmaps: via sub2video
 * (`alphaextract`) cada evento vira uma imagem de TEXTO PRETO em fundo branco (o
 * alpha do glifo marca o traço; os "buracos" das letras são transparentes →
 * ficam brancos). Uma imagem por evento (mais frames "limpos" que descartamos);
 * os tempos vêm do ffprobe (pts + duração dos pacotes), casados por ordem.
 */
async function renderVobsubImages(
  videoPath: string,
  index: number,
  signal?: AbortSignal
): Promise<SubtitleImage[]> {
  const ffmpeg = await resolveBinary('ffmpeg')
  const ffprobe = await resolveBinary('ffprobe')
  if (!ffmpeg || !ffprobe) throw new Error('ffmpeg/ffprobe não encontrado.')

  // Tempos exatos: cada pacote de legenda tem pts + duração.
  const timings: Array<{ startMs: number; endMs: number }> = []
  {
    const p = Bun.spawn(
      [ffprobe, '-v', 'error', '-select_streams', String(index), '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', videoPath],
      { stdout: 'pipe', stderr: 'ignore' }
    )
    const out = await new Response(p.stdout).text()
    await p.exited
    for (const line of out.split('\n')) {
      const [pts, dur] = line.split(',')
      const s = parseFloat(pts)
      if (!Number.isFinite(s)) continue
      const d = parseFloat(dur)
      timings.push({ startMs: Math.round(s * 1000), endMs: Math.round((s + (Number.isFinite(d) && d > 0 ? d : 2)) * 1000) })
    }
  }
  logi(`OCR VobSub: renderizando ${timings.length} evento(s) com o ffmpeg…`)

  // sub2video: uma imagem (PGM) por evento, texto preto em branco. Downscale
  // pra no máx. 1280 de largura (OCR já rende bem e economiza CPU/memória).
  const proc = Bun.spawn(
    [
      ffmpeg, '-v', 'error', '-i', videoPath,
      '-filter_complex', `[0:${index}]alphaextract,negate,format=gray,scale='min(1280,iw)':-1[v]`,
      // passthrough: UMA imagem por evento (senão o ffmpeg duplica o frame a
      // cada quadro-de-tempo enquanto a legenda fica visível → milhares de cópias)
      '-map', '[v]', '-vsync', 'passthrough', '-f', 'image2pipe', '-vcodec', 'pgm', '-'
    ],
    { stdout: 'pipe', stderr: 'ignore' }
  )

  const content: SubtitleImage[] = []
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  let buf: Uint8Array = new Uint8Array(0)
  for (;;) {
    if (signal?.aborted) {
      try {
        proc.kill()
      } catch {
        // ignora
      }
      break
    }
    const { done, value } = await reader.read()
    if (value && value.length) {
      const merged = new Uint8Array(buf.length + value.length)
      merged.set(buf)
      merged.set(value, buf.length)
      buf = merged
    }
    for (;;) {
      const frame = takePgm(buf)
      if (!frame) break
      buf = frame.rest
      const cropped = cropDark(frame.img)
      if (cropped) {
        content.push(cropped) // descarta frames "limpos" (em branco)
        if (content.length % 200 === 0) logi(`OCR VobSub: ${content.length} imagens renderizadas…`)
      }
    }
    if (done) break
  }
  await proc.exited

  if (content.length !== timings.length) {
    logw(`OCR VobSub: ${content.length} imagens vs ${timings.length} tempos — casando pelo menor.`)
  }
  const n = Math.min(content.length, timings.length)
  for (let i = 0; i < n; i++) {
    content[i].startMs = timings[i].startMs
    content[i].endMs = timings[i].endMs
  }
  return content.slice(0, n)
}

function isPgmWs(b: number): boolean {
  return b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09
}

/** Tenta extrair UM PGM (P5) do início do buffer; null se ainda incompleto. */
function takePgm(buf: Uint8Array): { img: SubtitleImage; rest: Uint8Array } | null {
  if (buf.length < 2 || buf[0] !== 0x50 || buf[1] !== 0x35) return null // "P5"
  let i = 2
  const nums: number[] = []
  while (nums.length < 3) {
    while (i < buf.length && isPgmWs(buf[i])) i++
    if (i >= buf.length) return null
    let v = 0
    let started = false
    while (i < buf.length && buf[i] >= 0x30 && buf[i] <= 0x39) {
      v = v * 10 + (buf[i] - 0x30)
      i++
      started = true
    }
    if (!started) return null
    if (i >= buf.length) return null // número pode continuar no próximo chunk
    nums.push(v)
  }
  const [w, h] = nums
  const dataStart = i + 1 // um único whitespace após o maxval
  const need = dataStart + w * h
  if (buf.length < need) return null
  return {
    img: { startMs: 0, endMs: 0, width: w, height: h, gray: new Uint8Array(buf.subarray(dataStart, need)) },
    rest: new Uint8Array(buf.subarray(need))
  }
}

/** Recorta a caixa dos pixels escuros (texto). null se a imagem está em branco. */
function cropDark(img: SubtitleImage): SubtitleImage | null {
  const { width: w, height: h, gray } = img
  const TH = 128
  const MARGIN = 8
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    const row = y * w
    let rowHas = false
    for (let x = 0; x < w; x++) {
      if (gray[row + x] < TH) {
        rowHas = true
        if (x < minX) minX = x
        if (x > maxX) maxX = x
      }
    }
    if (rowHas) {
      if (y < minY) minY = y
      maxY = y
    }
  }
  if (maxX < 0) return null // sem pixel escuro → frame "limpo"
  minX = Math.max(0, minX - MARGIN)
  minY = Math.max(0, minY - MARGIN)
  maxX = Math.min(w - 1, maxX + MARGIN)
  maxY = Math.min(h - 1, maxY + MARGIN)
  const cw = maxX - minX + 1
  const ch = maxY - minY + 1
  const out = new Uint8Array(cw * ch)
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) out[y * cw + x] = gray[(minY + y) * w + (minX + x)]
  }
  return { startMs: 0, endMs: 0, width: cw, height: ch, gray: out }
}

/** Core compartilhado: imagens (PGS ou VobSub) → .srt via OCR, retomável. */
async function ocrImagesToSrt(
  videoPath: string,
  index: number,
  language: string,
  images: SubtitleImage[],
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<string> {
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
    // canônico: a faixa vem "eng" do ffprobe → grava `.en.srt` (padrão Jellyfin)
    `${basename(videoPath, extname(videoPath))}.${canonicalLang(language)}.srt`
  )
  const markerPath = ocrMarkerPath(srtPath)
  const size = Bun.file(videoPath).size
  const tmpBase = joinPath(process.env.TMPDIR ?? '/tmp', `legenda-ocr-${size}-${index}`)

  // Retoma de um .srt parcial existente (alinha pela primeira imagem não feita)
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
