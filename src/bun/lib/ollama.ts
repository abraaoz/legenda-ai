import { logd } from './logger'

// Cliente mínimo do Ollama (servidor local em http://localhost:11434 por padrão).
// Não precisa de chave de API — roda 100% local.

export interface OllamaStatus {
  available: boolean
  models: string[]
}

/** Lista os modelos instalados no Ollama (e se o servidor responde). */
export async function listModels(baseUrl: string): Promise<OllamaStatus> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(3000)
    })
    if (!res.ok) return { available: false, models: [] }
    const data = (await res.json()) as { models?: Array<{ name: string }> }
    return { available: true, models: (data.models ?? []).map((m) => m.name) }
  } catch {
    return { available: false, models: [] }
  }
}

/** Uma rodada de chat (sem streaming) e devolve o texto da resposta. */
export async function chat(
  baseUrl: string,
  model: string,
  system: string,
  user: string,
  cancelSignal?: AbortSignal
): Promise<string> {
  logd(`Ollama chat: model=${model}, prompt=${user.length} chars`)
  // Timeout generoso (o 1º lote carrega o modelo) combinado com o cancelamento.
  const timeout = AbortSignal.timeout(300_000)
  const signal = cancelSignal ? AbortSignal.any([timeout, cancelSignal]) : timeout
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      stream: false,
      keep_alive: '5m',
      options: { temperature: 0.2 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  })
  if (!res.ok) {
    throw new Error(`Ollama respondeu ${res.status}: ${await res.text()}`)
  }
  const data = (await res.json()) as { message?: { content?: string } }
  return data.message?.content ?? ''
}
