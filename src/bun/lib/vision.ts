import { resolveBinary } from './ffmpeg'
import { logi, logw } from './logger'
import { joinPath } from './paths'
import type { SubtitleImage } from './pgs'

// Fonte Swift do helper de OCR do macOS (Vision), em base64 para evitar escaping.
// Compilada sob demanda com swiftc; ver src/bun/native/visionocr.swift.
const VISION_SWIFT_B64 =
  'aW1wb3J0IEZvdW5kYXRpb24KaW1wb3J0IFZpc2lvbgppbXBvcnQgQ29yZUdyYXBoaWNzCgovLyBMw6ogdW0gUEdNIChQNSkgZSBkZXZvbHZlIHVtIENHSW1hZ2UgZW0gdG9ucyBkZSBjaW56YS4KZnVuYyBsb2FkUEdNKF8gcGF0aDogU3RyaW5nKSAtPiBDR0ltYWdlPyB7CiAgZ3VhcmQgbGV0IGRhdGEgPSBGaWxlTWFuYWdlci5kZWZhdWx0LmNvbnRlbnRzKGF0UGF0aDogcGF0aCkgZWxzZSB7IHJldHVybiBuaWwgfQogIGxldCBiID0gW1VJbnQ4XShkYXRhKQogIHZhciBpID0gMAogIGZ1bmMgaXNXUyhfIGM6IFVJbnQ4KSAtPiBCb29sIHsgYyA9PSAzMiB8fCBjID09IDEwIHx8IGMgPT0gOSB8fCBjID09IDEzIH0KICBmdW5jIHNraXBXUygpIHsgd2hpbGUgaSA8IGIuY291bnQgJiYgaXNXUyhiW2ldKSB7IGkgKz0gMSB9IH0KICBmdW5jIHRva2VuKCkgLT4gU3RyaW5nIHsgc2tpcFdTKCk7IHZhciBzID0gIiI7IHdoaWxlIGkgPCBiLmNvdW50ICYmICFpc1dTKGJbaV0pIHsgcy5hcHBlbmQoQ2hhcmFjdGVyKFVuaWNvZGVTY2FsYXIoYltpXSkpKTsgaSArPSAxIH07IHJldHVybiBzIH0KICBndWFyZCB0b2tlbigpID09ICJQNSIsIGxldCB3ID0gSW50KHRva2VuKCkpLCBsZXQgaCA9IEludCh0b2tlbigpKSwgSW50KHRva2VuKCkpICE9IG5pbCBlbHNlIHsgcmV0dXJuIG5pbCB9CiAgaSArPSAxIC8vIHVtIHdoaXRlc3BhY2UgYXDDs3MgbyBtYXh2YWwKICBsZXQgbiA9IHcgKiBoCiAgZ3VhcmQgYi5jb3VudCAtIGkgPj0gbiBlbHNlIHsgcmV0dXJuIG5pbCB9CiAgbGV0IHB4ID0gQXJyYXkoYltpLi48aStuXSkKICBndWFyZCBsZXQgcHJvdmlkZXIgPSBDR0RhdGFQcm92aWRlcihkYXRhOiBEYXRhKHB4KSBhcyBDRkRhdGEpIGVsc2UgeyByZXR1cm4gbmlsIH0KICByZXR1cm4gQ0dJbWFnZSh3aWR0aDogdywgaGVpZ2h0OiBoLCBiaXRzUGVyQ29tcG9uZW50OiA4LCBiaXRzUGVyUGl4ZWw6IDgsIGJ5dGVzUGVyUm93OiB3LAogICAgICAgICAgICAgICAgIHNwYWNlOiBDR0NvbG9yU3BhY2VDcmVhdGVEZXZpY2VHcmF5KCksIGJpdG1hcEluZm86IENHQml0bWFwSW5mbyhyYXdWYWx1ZTogQ0dJbWFnZUFscGhhSW5mby5ub25lLnJhd1ZhbHVlKSwKICAgICAgICAgICAgICAgICBwcm92aWRlcjogcHJvdmlkZXIsIGRlY29kZTogbmlsLCBzaG91bGRJbnRlcnBvbGF0ZTogZmFsc2UsIGludGVudDogLmRlZmF1bHRJbnRlbnQpCn0KCmxldCBhcmdzID0gQ29tbWFuZExpbmUuYXJndW1lbnRzCmd1YXJkIGFyZ3MuY291bnQgPiAyIGVsc2UgeyBleGl0KDEpIH0KbGV0IGxhbmcgPSBhcmdzWzFdCmZvciBpZHggaW4gMi4uPGFyZ3MuY291bnQgewogIGF1dG9yZWxlYXNlcG9vbCB7CiAgICB2YXIgbGluZXM6IFtTdHJpbmddID0gW10KICAgIGlmIGxldCBjZyA9IGxvYWRQR00oYXJnc1tpZHhdKSB7CiAgICAgIGxldCByZXEgPSBWTlJlY29nbml6ZVRleHRSZXF1ZXN0KCkKICAgICAgcmVxLnJlY29nbml0aW9uTGV2ZWwgPSAuYWNjdXJhdGUKICAgICAgcmVxLnVzZXNMYW5ndWFnZUNvcnJlY3Rpb24gPSB0cnVlCiAgICAgIHJlcS5yZWNvZ25pdGlvbkxhbmd1YWdlcyA9IFtsYW5nXQogICAgICB0cnk/IFZOSW1hZ2VSZXF1ZXN0SGFuZGxlcihjZ0ltYWdlOiBjZywgb3B0aW9uczogWzpdKS5wZXJmb3JtKFtyZXFdKQogICAgICBpZiBsZXQgb2JzID0gcmVxLnJlc3VsdHMgewogICAgICAgIGZvciBvIGluIG9icy5zb3J0ZWQoYnk6IHsgJDAuYm91bmRpbmdCb3gubWlkWSA+ICQxLmJvdW5kaW5nQm94Lm1pZFkgfSkgewogICAgICAgICAgaWYgbGV0IHQgPSBvLnRvcENhbmRpZGF0ZXMoMSkuZmlyc3QgeyBsaW5lcy5hcHBlbmQodC5zdHJpbmcpIH0KICAgICAgICB9CiAgICAgIH0KICAgIH0KICAgIHByaW50KGxpbmVzLmpvaW5lZChzZXBhcmF0b3I6ICJcbiIpKQogICAgcHJpbnQoIkBARU5ESU1HQEAiKQogIH0KfQo='

// Códigos ISO 639-2 das faixas → BCP-47 do Vision.
const VISION_LANG: Record<string, string> = {
  eng: 'en-US',
  por: 'pt-BR',
  spa: 'es-ES',
  fre: 'fr-FR',
  fra: 'fr-FR',
  ger: 'de-DE',
  deu: 'de-DE',
  ita: 'it-IT',
  jpn: 'ja-JP'
}

export function visionLang(code: string): string {
  return VISION_LANG[code.toLowerCase()] ?? 'en-US'
}

function cacheDir(): string {
  return joinPath(process.env.HOME ?? '.', 'Library', 'Caches', 'LegendaAIpraMim')
}

const DELIM = '@@ENDIMG@@\n'
let resolved: string | null | undefined

/** Caminho do helper visionocr, compilando sob demanda (macOS + swiftc). null = indisponível. */
export async function resolveVisionOcr(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  if (resolved !== undefined) return resolved

  // 1. binário pré-compilado embutido no app (Contents/Resources/app/visionocr).
  // O bun roda com CWD em Contents/MacOS, então os resources ficam em ../Resources.
  const bundled = joinPath(process.cwd(), '..', 'Resources', 'app', 'visionocr')
  if (await Bun.file(bundled).exists()) {
    resolved = bundled
    return bundled
  }

  // 2. cache já compilado sob demanda.
  const bin = joinPath(cacheDir(), 'visionocr-v1')
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
  const src = joinPath(cacheDir(), 'visionocr-v1.swift')
  await Bun.write(src, Buffer.from(VISION_SWIFT_B64, 'base64').toString('utf8'))
  logi('Compilando o helper de OCR do macOS (Vision) — só na primeira vez…')
  const proc = Bun.spawn([swiftc, '-O', src, '-o', bin], { stdout: 'ignore', stderr: 'pipe' })
  const err = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) {
    logw(`Falha ao compilar o Vision (caindo para Tesseract): ${err.split('\n').slice(-2).join(' ')}`)
    resolved = null
    return null
  }
  logi('Vision helper compilado.')
  resolved = bin
  return bin
}

export async function hasVision(): Promise<boolean> {
  return (await resolveVisionOcr()) !== null
}

function toPgm(img: SubtitleImage): Uint8Array {
  const header = `P5\n${img.width} ${img.height}\n255\n`
  const buf = new Uint8Array(header.length + img.gray.length)
  for (let i = 0; i < header.length; i++) buf[i] = header.charCodeAt(i)
  buf.set(img.gray, header.length)
  return buf
}

/** OCR de um lote de imagens numa única invocação do Vision (amortiza a carga). */
export async function visionOcrChunk(
  bin: string,
  lang: string,
  images: SubtitleImage[],
  tmpBase: string
): Promise<string[]> {
  const paths: string[] = []
  for (let j = 0; j < images.length; j++) {
    const p = `${tmpBase}-${j}.pgm`
    await Bun.write(p, toPgm(images[j]))
    paths.push(p)
  }
  const proc = Bun.spawn([bin, lang, ...paths], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  const segs = out.split(DELIM)
  return images.map((_, j) => (segs[j] ?? '').trim())
}
