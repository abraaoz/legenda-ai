import type { TranslateResult, TranslationStatus } from '../../shared/types'
import { appleLang, appleTranslateBatch, resolveAppleTranslate } from './apple'
import { type AzureConfig, azureTranslate } from './azure'
import { extractEmbedded, extractEmbeddedToString } from './ffmpeg'
import { logi, logw } from './logger'
import { ocrMarkerPath, ocrPgsToSrt } from './ocr'
import { chat } from './ollama'
import { basename, dirname, extname, joinPath } from './paths'
import { type Cue, parseSrt, serializeSrt } from './srt'

// Nome legível de cada idioma (para instruir o LLM do Ollama).
const LANGUAGE_NAMES: Record<string, string> = {
  'pt-br': 'português do Brasil',
  'pt-pt': 'português de Portugal',
  en: 'inglês',
  es: 'espanhol',
  fr: 'francês',
  it: 'italiano',
  de: 'alemão',
  ja: 'japonês'
}

// Nossos códigos → códigos BCP-47 aceitos pelo Azure Translator.
const AZURE_LANG: Record<string, string> = {
  'pt-br': 'pt',
  'pt-pt': 'pt-pt',
  en: 'en',
  es: 'es',
  fr: 'fr',
  it: 'it',
  de: 'de',
  ja: 'ja'
}

function languageName(code: string): string {
  return LANGUAGE_NAMES[code.toLowerCase()] ?? code
}

function azureLangCode(code: string): string {
  return AZURE_LANG[code.toLowerCase()] ?? code
}

const SYSTEM_PROMPT =
  'Você é um tradutor profissional de legendas. Traduz preservando o sentido, ' +
  'o tom e a naturalidade da fala. Responde SOMENTE com as traduções pedidas, ' +
  'sem comentários, sem aspas extras.'

/**
 * Motor de tradução plugável. `batchSize` = quantas falas por request; o Azure
 * aceita muito mais por chamada (menos requisições → evita o 429 de rate limit),
 * enquanto o LLM local rende melhor com lotes pequenos.
 */
export interface BatchTranslator {
  batchSize: number
  /** Pausa entre lotes (ms) para suavizar rajadas e evitar rate limit. */
  delayMs: number
  run: (texts: string[], signal?: AbortSignal) => Promise<string[]>
}

/** Motor de tradução via LLM local (Ollama). */
export function createOllamaTranslator(baseUrl: string, model: string, targetCode: string): BatchTranslator {
  if (!model) throw new Error('Escolha um modelo do Ollama nas configurações.')
  const targetName = languageName(targetCode)
  return {
    batchSize: 20,
    delayMs: 0, // local, sem limite de taxa
    run: async (texts, signal) => {
      const numbered = texts.map((t, i) => `${i + 1}: ${t.replace(/\n+/g, ' ')}`).join('\n')
      const user =
        `Traduza para ${targetName} cada legenda numerada abaixo. ` +
        `Responda uma por linha, no formato "N: tradução", mantendo o mesmo número ` +
        `e a mesma quantidade de linhas.\n\n${numbered}`
      const reply = await chat(baseUrl, model, SYSTEM_PROMPT, user, signal)
      const byNumber = new Map<number, string>()
      for (const line of reply.split('\n')) {
        const m = line.match(/^\s*(\d+)\s*[:\-.)]\s*(.+)$/)
        if (m) byNumber.set(Number(m[1]), m[2].trim())
      }
      // Se algo faltar, mantém o texto original (não desincroniza).
      return texts.map((original, i) => byNumber.get(i + 1) ?? original)
    }
  }
}

/** Motor de tradução via Azure AI Translator (nuvem). Lotes grandes. */
export function createAzureTranslator(cfg: AzureConfig, targetCode: string): BatchTranslator {
  if (!cfg.key) throw new Error('Configure a chave do Azure Translator nas configurações.')
  const to = azureLangCode(targetCode)
  return {
    batchSize: 100,
    delayMs: 250, // suaviza a rajada (F0 tem limite de req/s baixo)
    run: (texts, signal) => azureTranslate(cfg, to, texts, signal)
  }
}

/**
 * Motor de tradução on-device da Apple (framework Translation, macOS 15+).
 * Offline e sem limite de taxa, como o Ollama, mas sem baixar modelo. Precisa
 * do idioma de origem (BCP-47); vazio = detecção automática.
 */
export async function createAppleTranslator(
  sourceCode: string,
  targetCode: string
): Promise<BatchTranslator> {
  const bin = await resolveAppleTranslate()
  if (!bin) throw new Error('Tradução da Apple indisponível (requer macOS 15+).')
  const src = sourceCode ? appleLang(sourceCode) : ''
  const tgt = appleLang(targetCode)
  const tmpDir = process.env.TMPDIR ?? '/tmp'
  let seq = 0
  return {
    batchSize: 80,
    delayMs: 0, // on-device, sem limite de taxa
    run: (texts, signal) =>
      appleTranslateBatch(bin, src, tgt, texts, joinPath(tmpDir, `legenda-apple-${seq++}`), signal)
  }
}

export interface TranslateEmbeddedArgs {
  path: string
  index: number
  sourceLanguage: string
  targetCode: string
  /** true = faixa de texto (ffmpeg); false = imagem (OCR via Tesseract). */
  isText: boolean
}

/** Caminho do .srt traduzido para um vídeo + idioma alvo. Nome "limpo"
 * (<base>.<idioma>.srt) para os players carregarem automaticamente. */
function targetSrtPath(path: string, targetCode: string): string {
  const base = basename(path, extname(path))
  return joinPath(dirname(path), `${base}.${targetCode}.srt`)
}

/** Caminho do .srt de origem (texto extraído ou OCR). */
function sourceSrtPath(path: string, sourceLanguage: string): string {
  const base = basename(path, extname(path))
  return joinPath(dirname(path), `${base}.${sourceLanguage}.srt`)
}

/**
 * Produz o .srt de ORIGEM: extração direta (texto) ou OCR (imagem/PGS).
 * Idempotente para imagem: reusa o .srt já reconhecido, se existir.
 */
async function produceSourceSrt(
  args: TranslateEmbeddedArgs,
  onOcrProgress: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<string> {
  if (args.isText) {
    return (await extractEmbedded(args.path, args.index, args.sourceLanguage, true)).savedPath
  }
  const cached = sourceSrtPath(args.path, args.sourceLanguage)
  // Só reusa se o OCR estiver COMPLETO (sem marcador .part); senão retoma.
  const incomplete = await Bun.file(ocrMarkerPath(cached)).exists()
  if (!incomplete && (await Bun.file(cached).exists()) && (await Bun.file(cached).text()).trim().length > 0) {
    logi(`OCR já completo, reusando: ${cached}`)
    return cached
  }
  return ocrPgsToSrt(args.path, args.index, args.sourceLanguage, onOcrProgress, signal)
}

/**
 * Estado de uma tradução: quantas falas já estão em disco (done) vs. total da
 * fonte. Só faz trabalho pesado se já existir um .<idioma>.srt parcial.
 */
export async function getTranslationStatus(
  path: string,
  index: number,
  sourceLanguage: string,
  targetCode: string
): Promise<TranslationStatus> {
  const targetPath = targetSrtPath(path, targetCode)
  if (!(await Bun.file(targetPath).exists())) return { done: 0, total: 0 }
  const done = parseSrt(await Bun.file(targetPath).text()).length
  // total: prefere o .srt de origem em disco (vale p/ OCR); senão extrai texto.
  const src = sourceSrtPath(path, sourceLanguage)
  if (await Bun.file(src).exists()) {
    return { done, total: parseSrt(await Bun.file(src).text()).length }
  }
  try {
    return { done, total: parseSrt(await extractEmbeddedToString(path, index)).length }
  } catch {
    return { done, total: done }
  }
}

/**
 * Fluxo de tradução, idempotente e retomável: extrai a legenda embutida
 * (100% sincronizada), traduz em lotes preservando os timestamps e grava
 * "<nome>.<idioma-alvo>.srt" a CADA lote. Se já existir um parcial alinhado,
 * retoma de onde parou. Cancelar mantém o que já foi traduzido em disco.
 */
export async function aiTranslateEmbedded(
  args: TranslateEmbeddedArgs,
  translate: BatchTranslator,
  onProgress: (done: number, total: number) => void,
  onOcrProgress: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<TranslateResult> {
  // Produz o .srt de origem (texto direto ou OCR de PGS), preservando tempos.
  const sourceSrt = await produceSourceSrt(args, onOcrProgress, signal)
  const targetPath = targetSrtPath(args.path, args.targetCode)
  return translateSrtCore(sourceSrt, targetPath, args.targetCode, translate, onProgress, signal)
}

/**
 * Traduz um arquivo `.srt` EXTERNO (já existente) para o idioma alvo, gravando
 * "<nome-do-vídeo>.<idioma-alvo>.srt" ao lado. Idempotente/retomável.
 */
export async function aiTranslateSrtFile(
  args: { videoPath: string; srtPath: string; targetCode: string },
  translate: BatchTranslator,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<TranslateResult> {
  const targetPath = targetSrtPath(args.videoPath, args.targetCode)
  return translateSrtCore(args.srtPath, targetPath, args.targetCode, translate, onProgress, signal)
}

/**
 * Núcleo da tradução, idempotente e retomável: lê o `.srt` de origem, traduz em
 * lotes preservando os timestamps e grava o alvo a CADA lote. Se já existir um
 * parcial alinhado, retoma de onde parou. Cancelar mantém o que já está em disco.
 */
async function translateSrtCore(
  sourceSrt: string,
  targetPath: string,
  targetCode: string,
  translate: BatchTranslator,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<TranslateResult> {
  const sourceCues = parseSrt(await Bun.file(sourceSrt).text())
  if (sourceCues.length === 0) throw new Error('A legenda de origem está vazia.')

  // Origem e destino podem coincidir se os idiomas forem iguais — não
  // sobrescreve a fonte com ela mesma.
  if (targetPath === sourceSrt) {
    throw new Error('Idioma de origem e destino são iguais — nada a traduzir.')
  }
  // Retoma de um parcial existente, se ele alinhar com a fonte (mesmos timestamps).
  const translated: Cue[] = []
  if (await Bun.file(targetPath).exists()) {
    const parsed = parseSrt(await Bun.file(targetPath).text())
    const aligned =
      parsed.length <= sourceCues.length && parsed.every((c, k) => c.time === sourceCues[k].time)
    if (aligned) translated.push(...parsed)
    else logw('Legenda parcial não alinha com a fonte; recomeçando do zero.')
  }

  onProgress(translated.length, sourceCues.length)
  if (translated.length >= sourceCues.length) {
    logi(`Já traduzido (${sourceCues.length} falas): ${targetPath}`)
    return { savedPath: targetPath, done: sourceCues.length, total: sourceCues.length }
  }
  const batchSize = translate.batchSize
  logi(
    `${translated.length > 0 ? `Retomando da fala ${translated.length + 1}` : 'Traduzindo'} de ${sourceCues.length} para ${languageName(targetCode)} (lotes de ${batchSize})`
  )

  // 3. traduz em lotes, gravando o arquivo após CADA lote
  for (let i = translated.length; i < sourceCues.length; i += batchSize) {
    if (signal?.aborted) break
    const batch = sourceCues.slice(i, i + batchSize)
    logi(`Lote: falas ${i + 1}–${i + batch.length} de ${sourceCues.length}`)
    let outputs: string[]
    try {
      outputs = await translate.run(batch.map((c) => c.text), signal)
    } catch (err) {
      if (signal?.aborted) break
      throw err
    }
    batch.forEach((cue, j) => translated.push({ time: cue.time, text: outputs[j] }))
    await Bun.write(targetPath, serializeSrt(translated)) // salvamento incremental
    onProgress(translated.length, sourceCues.length)

    // Pausa preventiva entre lotes (evita rate limit), exceto no último.
    if (translate.delayMs > 0 && i + batchSize < sourceCues.length) {
      await Bun.sleep(translate.delayMs)
    }
  }

  const done = translated.length
  logi(
    done >= sourceCues.length
      ? `Tradução concluída: ${targetPath}`
      : `Tradução interrompida em ${done}/${sourceCues.length} (salva): ${targetPath}`
  )
  return { savedPath: targetPath, done, total: sourceCues.length }
}
