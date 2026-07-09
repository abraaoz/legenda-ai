import { resolveBinary } from './ffmpeg'
import { logi, logw } from './logger'
import { joinPath } from './paths'

// Fonte Swift do helper de tradução on-device do macOS (framework Translation),
// em base64 para evitar escaping. Compilada sob demanda com swiftc.
// Ver src/bun/native/appletranslate.swift.
const APPLE_SWIFT_B64 =
  'aW1wb3J0IFN3aWZ0VUkKaW1wb3J0IFRyYW5zbGF0aW9uCmltcG9ydCBBcHBLaXQKaW1wb3J0IEZvdW5kYXRpb24KCi8vIFRyYWR1w6fDo28gb24tZGV2aWNlIGRvIG1hY09TIChmcmFtZXdvcmsgVHJhbnNsYXRpb24sIG1hY09TIDE1KykuCi8vIFVzbzogYXBwbGV0cmFuc2xhdGUgPHNyY3wiIj4gPHRndD4gPGlucHV0RmlsZT4KLy8gTyBpbnB1dEZpbGUgdGVtIG9zIHRleHRvcyBzZXBhcmFkb3MgcG9yIE5VTCAoXDApOyBhIHNhw61kYSAoc3Rkb3V0KSB0YW1iw6ltLgovLyBzcmMgdmF6aW8gPSBkZXRlY8Onw6NvIGF1dG9tw6F0aWNhIGRvIGlkaW9tYSBkZSBvcmlnZW0uCgpAYXZhaWxhYmxlKG1hY09TIDE1LjAsICopCnN0cnVjdCBCYXRjaFZpZXc6IFZpZXcgewogIGxldCBzcmM6IFN0cmluZwogIGxldCB0Z3Q6IFN0cmluZwogIGxldCB0ZXh0czogW1N0cmluZ10KICB2YXIgYm9keTogc29tZSBWaWV3IHsKICAgIGxldCBjZmcgPSBUcmFuc2xhdGlvblNlc3Npb24uQ29uZmlndXJhdGlvbigKICAgICAgc291cmNlOiBzcmMuaXNFbXB0eSA/IG5pbCA6IExvY2FsZS5MYW5ndWFnZShpZGVudGlmaWVyOiBzcmMpLAogICAgICB0YXJnZXQ6IExvY2FsZS5MYW5ndWFnZShpZGVudGlmaWVyOiB0Z3QpKQogICAgQ29sb3IuY2xlYXIudHJhbnNsYXRpb25UYXNrKGNmZykgeyBzZXNzaW9uIGluCiAgICAgIGRvIHsKICAgICAgICBsZXQgcmVxcyA9IHRleHRzLmVudW1lcmF0ZWQoKS5tYXAgewogICAgICAgICAgVHJhbnNsYXRpb25TZXNzaW9uLlJlcXVlc3Qoc291cmNlVGV4dDogJDEsIGNsaWVudElkZW50aWZpZXI6IFN0cmluZygkMCkpCiAgICAgICAgfQogICAgICAgIGxldCByZXNwID0gdHJ5IGF3YWl0IHNlc3Npb24udHJhbnNsYXRpb25zKGZyb206IHJlcXMpCiAgICAgICAgdmFyIGJ5SWQgPSBbU3RyaW5nOiBTdHJpbmddKCkKICAgICAgICBmb3IgciBpbiByZXNwIHsgaWYgbGV0IGlkID0gci5jbGllbnRJZGVudGlmaWVyIHsgYnlJZFtpZF0gPSByLnRhcmdldFRleHQgfSB9CiAgICAgICAgbGV0IG91dCA9ICgwLi48dGV4dHMuY291bnQpLm1hcCB7IGJ5SWRbU3RyaW5nKCQwKV0gPz8gdGV4dHNbJDBdIH0KICAgICAgICBGaWxlSGFuZGxlLnN0YW5kYXJkT3V0cHV0LndyaXRlKERhdGEob3V0LmpvaW5lZChzZXBhcmF0b3I6ICJcdXswfSIpLnV0ZjgpKQogICAgICB9IGNhdGNoIHsKICAgICAgICBGaWxlSGFuZGxlLnN0YW5kYXJkRXJyb3Iud3JpdGUoRGF0YSgiRVJSOiBcKGVycm9yKSIudXRmOCkpCiAgICAgICAgZXhpdCgyKQogICAgICB9CiAgICAgIGV4aXQoMCkKICAgIH0KICB9Cn0KCmxldCBhcmdzID0gQ29tbWFuZExpbmUuYXJndW1lbnRzCmd1YXJkIGFyZ3MuY291bnQgPiAzLCAjYXZhaWxhYmxlKG1hY09TIDE1LjAsICopIGVsc2UgewogIEZpbGVIYW5kbGUuc3RhbmRhcmRFcnJvci53cml0ZShEYXRhKCJ1c286IGFwcGxldHJhbnNsYXRlIDxzcmM+IDx0Z3Q+IDxmaWxlPiAobWFjT1MgMTUrKSIudXRmOCkpCiAgZXhpdCgxKQp9CmxldCBkYXRhID0gRmlsZU1hbmFnZXIuZGVmYXVsdC5jb250ZW50cyhhdFBhdGg6IGFyZ3NbM10pID8/IERhdGEoKQpsZXQgdGV4dHMgPSAoU3RyaW5nKGRhdGE6IGRhdGEsIGVuY29kaW5nOiAudXRmOCkgPz8gIiIpLmNvbXBvbmVudHMoc2VwYXJhdGVkQnk6ICJcdXswfSIpCmxldCBhcHAgPSBOU0FwcGxpY2F0aW9uLnNoYXJlZAphcHAuc2V0QWN0aXZhdGlvblBvbGljeSguYWNjZXNzb3J5KSAvLyBzZW0gw61jb25lIG5vIERvY2sKbGV0IHdpbiA9IE5TV2luZG93KAogIGNvbnRlbnRSZWN0OiBOU1JlY3QoeDogLTIwMDAsIHk6IC0yMDAwLCB3aWR0aDogMSwgaGVpZ2h0OiAxKSwKICBzdHlsZU1hc2s6IFsuYm9yZGVybGVzc10sIGJhY2tpbmc6IC5idWZmZXJlZCwgZGVmZXI6IGZhbHNlKQp3aW4uY29udGVudFZpZXcgPSBOU0hvc3RpbmdWaWV3KHJvb3RWaWV3OiBCYXRjaFZpZXcoc3JjOiBhcmdzWzFdLCB0Z3Q6IGFyZ3NbMl0sIHRleHRzOiB0ZXh0cykpCndpbi5vcmRlckZyb250UmVnYXJkbGVzcygpCmFwcC5ydW4oKQo='

// Códigos (ISO 639-2 das faixas + nossos códigos internos) → BCP-47 do Apple.
const APPLE_LANG: Record<string, string> = {
  // idioma-alvo (nossos códigos)
  'pt-br': 'pt-BR',
  'pt-pt': 'pt-PT',
  en: 'en',
  es: 'es',
  fr: 'fr',
  it: 'it',
  de: 'de',
  ja: 'ja',
  // idioma-origem (ISO 639-2 vindo das faixas embutidas)
  eng: 'en',
  por: 'pt-BR',
  spa: 'es',
  fre: 'fr',
  fra: 'fr',
  ger: 'de',
  deu: 'de',
  ita: 'it',
  jpn: 'ja'
}

export function appleLang(code: string): string {
  return APPLE_LANG[code.toLowerCase()] ?? code
}

function cacheDir(): string {
  return joinPath(process.env.HOME ?? '.', 'Library', 'Caches', 'LegendaAIpraMim')
}

const NUL = String.fromCharCode(0)
let resolved: string | null | undefined

/** Caminho do helper appletranslate, compilando sob demanda. null = indisponível. */
export async function resolveAppleTranslate(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  if (resolved !== undefined) return resolved

  // 1. binário pré-compilado embutido no app (Contents/Resources/app/appletranslate).
  const bundled = joinPath(process.cwd(), '..', 'Resources', 'app', 'appletranslate')
  if (await Bun.file(bundled).exists()) {
    resolved = bundled
    return bundled
  }

  // 2. cache já compilado sob demanda.
  const bin = joinPath(cacheDir(), 'appletranslate-v1')
  if (await Bun.file(bin).exists()) {
    resolved = bin
    return bin
  }

  // 3. compila sob demanda (dev, ou quando não veio embutido).
  const swiftc = await resolveBinary('swiftc')
  if (!swiftc) {
    resolved = null
    return null
  }
  const src = joinPath(cacheDir(), 'appletranslate-v1.swift')
  await Bun.write(src, Buffer.from(APPLE_SWIFT_B64, 'base64').toString('utf8'))
  logi('Compilando o tradutor on-device do macOS (Apple Translation) — só na primeira vez…')
  const proc = Bun.spawn([swiftc, '-O', src, '-o', bin], { stdout: 'ignore', stderr: 'pipe' })
  const err = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) {
    logw(`Falha ao compilar o Apple Translation: ${err.split('\n').slice(-2).join(' ')}`)
    resolved = null
    return null
  }
  logi('Apple Translation helper compilado.')
  resolved = bin
  return bin
}

export async function hasAppleTranslate(): Promise<boolean> {
  return (await resolveAppleTranslate()) !== null
}

/**
 * Traduz um lote de textos numa única invocação do helper. Entrada e saída
 * são separadas por NUL (\0), via arquivo temporário para não estourar o argv.
 */
export async function appleTranslateBatch(
  bin: string,
  src: string,
  tgt: string,
  texts: string[],
  tmpBase: string,
  signal?: AbortSignal
): Promise<string[]> {
  const inFile = `${tmpBase}.apple-in`
  await Bun.write(inFile, texts.join(NUL))
  const proc = Bun.spawn([bin, src, tgt, inFile], { stdout: 'pipe', stderr: 'pipe', signal })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`Apple Translation falhou (${code}): ${err.slice(0, 200) || 'sem detalhe'}`)
  }
  const segs = out.split(NUL)
  // O motor às vezes insere linha em branco (\n\n) numa fala de 2 linhas; isso
  // quebraria o SRT (linha vazia separa cues). Colapsa para uma única quebra.
  return texts.map((original, j) => {
    const t = (segs[j] ?? '').replace(/\n{2,}/g, '\n').trim()
    return t.length > 0 ? t : original
  })
}
