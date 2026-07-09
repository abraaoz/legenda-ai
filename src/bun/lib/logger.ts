import type { LogEntry, LogLevel } from '../../shared/types'

// Log verboso do backend. Guarda um buffer (para a UI pegar o histórico ao
// abrir) e empurra cada linha para um "sink" (a webview) em tempo real.

const MAX_BUFFER = 1000
const buffer: LogEntry[] = []
let sink: ((entry: LogEntry) => void) | null = null

export function setLogSink(fn: (entry: LogEntry) => void): void {
  sink = fn
}

export function getLogBuffer(): LogEntry[] {
  return buffer.slice()
}

export function log(level: LogLevel, message: string): void {
  const entry: LogEntry = { time: Date.now(), level, message }
  buffer.push(entry)
  if (buffer.length > MAX_BUFFER) buffer.shift()
  // Também no stdout (visível no terminal / build de dev).
  process.stdout.write(`[${level}] ${message}\n`)
  try {
    sink?.(entry)
  } catch {
    // a webview pode ainda não estar pronta
  }
}

export const logi = (m: string): void => log('info', m)
export const logw = (m: string): void => log('warn', m)
export const loge = (m: string): void => log('error', m)
export const logd = (m: string): void => log('debug', m)
