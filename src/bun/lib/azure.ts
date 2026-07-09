import type { ValidateResult } from '../../shared/types'
import { logd, logw } from './logger'

// Cliente do Azure AI Translator (Cognitive Services — Text Translation).
// Doc: POST {endpoint}/translate?api-version=3.0&to=<lang> com corpo [{text}].
// A resposta vem na MESMA ordem da entrada — ideal para preservar timestamps.

export interface AzureConfig {
  key: string
  region: string
  endpoint: string
}

const DEFAULT_ENDPOINT = 'https://api.cognitive.microsofttranslator.com'

function normalizeEndpoint(endpoint: string): string {
  return (endpoint || DEFAULT_ENDPOINT).replace(/\/$/, '')
}

/**
 * Traduz um lote de textos para o idioma `to` (código BCP-47, ex.: "pt", "en").
 * `from` é omitido — o Azure detecta o idioma de origem automaticamente.
 */
export async function azureTranslate(
  cfg: AzureConfig,
  to: string,
  texts: string[],
  signal?: AbortSignal
): Promise<string[]> {
  if (texts.length === 0) return []
  const url = new URL(`${normalizeEndpoint(cfg.endpoint)}/translate`)
  url.searchParams.set('api-version', '3.0')
  url.searchParams.set('to', to)

  const body = JSON.stringify(texts.map((text) => ({ text })))
  logd(`Azure Translator → ${to} (${texts.length} textos, ${body.length} bytes)`)

  // Retenta em 429 (limite de taxa), respeitando Retry-After ou backoff exponencial.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': cfg.key,
        'Ocp-Apim-Subscription-Region': cfg.region,
        'Content-Type': 'application/json'
      },
      body,
      signal
    })

    if (res.status === 429 && attempt < 6) {
      // O F0 (grátis) tem janela de ~30s; começar direto em 30s evita perder
      // tempo em esperas curtas que ele nunca aceita. Retry-After tem prioridade.
      const headerWait = Number(res.headers.get('Retry-After'))
      const wait = headerWait > 0 ? headerWait : Math.min(30 + attempt * 15, 90)
      logw(`Azure 429 (limite de taxa) — aguardando ${wait}s e tentando de novo…`)
      await Bun.sleep(wait * 1000)
      if (signal?.aborted) throw new Error('Tradução cancelada.')
      continue
    }
    if (!res.ok) {
      throw new Error(`Azure Translator ${res.status}: ${await res.text()}`)
    }
    const data = (await res.json()) as Array<{ translations?: Array<{ text?: string }> }>
    return texts.map((original, i) => data[i]?.translations?.[0]?.text ?? original)
  }
}

/** Valida a chave/região do Azure fazendo uma tradução mínima. */
export async function azureValidate(cfg: AzureConfig): Promise<ValidateResult> {
  if (!cfg.key) return { valid: false, message: 'Informe a chave do Azure.' }
  if (!cfg.region) return { valid: false, message: 'Informe a região do Azure (ex.: brazilsouth).' }
  try {
    const out = await azureTranslate(cfg, 'en', ['teste'])
    return out.length > 0
      ? { valid: true, message: 'Credenciais do Azure válidas ✅' }
      : { valid: false, message: 'Resposta inesperada do Azure.' }
  } catch (err) {
    return { valid: false, message: (err as Error).message }
  }
}
