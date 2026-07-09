import { logi } from './logger'
import { joinPath } from './paths'
import type { SubtitleImage } from './pgs'

// Script PowerShell do OCR nativo do Windows (WinRT Windows.Media.Ocr), em
// base64. Não precisa compilar — é escrito no cache e executado direto.
// Ver src/bun/native/winocr.ps1.
const WINOCR_PS1_B64 =
  'IyBPQ1Igb24tZGV2aWNlIGRvIFdpbmRvd3MgKFdpblJUIFdpbmRvd3MuTWVkaWEuT2NyKSwgc2VtIGNvbXBpbGFyIG5hZGEuCiMgVXNvOiB3aW5vY3IucHMxIDxsYW5nLWJjcDQ3PiA8bWFuaWZlc3Q+CiMgICA8bWFuaWZlc3Q+ID0gYXJxdWl2byB0ZXh0byBjb20gdW0gY2FtaW5obyBkZSBCTVAgcG9yIGxpbmhhLgojIFNhw61kYSAoc3Rkb3V0LCBVVEYtOCk6IG8gdGV4dG8gZGUgY2FkYSBpbWFnZW0sIHNlZ3VpZG8gZGUgdW1hIGxpbmhhICJAQEVORElNR0BAIi4KcGFyYW0oW3N0cmluZ10kTGFuZywgW3N0cmluZ10kTWFuaWZlc3QpCiRFcnJvckFjdGlvblByZWZlcmVuY2UgPSAnU3RvcCcKW0NvbnNvbGVdOjpPdXRwdXRFbmNvZGluZyA9IFtTeXN0ZW0uVGV4dC5FbmNvZGluZ106OlVURjgKCkFkZC1UeXBlIC1Bc3NlbWJseU5hbWUgU3lzdGVtLlJ1bnRpbWUuV2luZG93c1J1bnRpbWUgfCBPdXQtTnVsbAoKIyBIZWxwZXIgcGFyYSBhZ3VhcmRhciAoc8OtbmNyb25vKSB1bSBJQXN5bmNPcGVyYXRpb248VD4gZG8gV2luUlQuCiRhc1Rhc2tHZW5lcmljID0gKFtTeXN0ZW0uV2luZG93c1J1bnRpbWVTeXN0ZW1FeHRlbnNpb25zXS5HZXRNZXRob2RzKCkgfCBXaGVyZS1PYmplY3QgewogICAgJF8uTmFtZSAtZXEgJ0FzVGFzaycgLWFuZCAkXy5HZXRQYXJhbWV0ZXJzKCkuQ291bnQgLWVxIDEgLWFuZAogICAgJF8uR2V0UGFyYW1ldGVycygpWzBdLlBhcmFtZXRlclR5cGUuTmFtZSAtZXEgJ0lBc3luY09wZXJhdGlvbmAxJwp9KVswXQpmdW5jdGlvbiBBd2FpdCgkb3AsICRyZXN1bHRUeXBlKSB7CiAgJGFzVGFzayA9ICRhc1Rhc2tHZW5lcmljLk1ha2VHZW5lcmljTWV0aG9kKCRyZXN1bHRUeXBlKQogICR0YXNrID0gJGFzVGFzay5JbnZva2UoJG51bGwsIEAoJG9wKSkKICAkdGFzay5XYWl0KC0xKSB8IE91dC1OdWxsCiAgJHRhc2suUmVzdWx0Cn0KCiMgQ2FycmVnYSBhcyBwcm9qZcOnw7VlcyBXaW5SVCAoQ29udGVudFR5cGUgPSBXaW5kb3dzUnVudGltZSkuClt2b2lkXVtXaW5kb3dzLk1lZGlhLk9jci5PY3JFbmdpbmUsIFdpbmRvd3MuRm91bmRhdGlvbiwgQ29udGVudFR5cGUgPSBXaW5kb3dzUnVudGltZV0KW3ZvaWRdW1dpbmRvd3MuR3JhcGhpY3MuSW1hZ2luZy5CaXRtYXBEZWNvZGVyLCBXaW5kb3dzLkZvdW5kYXRpb24sIENvbnRlbnRUeXBlID0gV2luZG93c1J1bnRpbWVdClt2b2lkXVtXaW5kb3dzLkdyYXBoaWNzLkltYWdpbmcuU29mdHdhcmVCaXRtYXAsIFdpbmRvd3MuRm91bmRhdGlvbiwgQ29udGVudFR5cGUgPSBXaW5kb3dzUnVudGltZV0KW3ZvaWRdW1dpbmRvd3MuU3RvcmFnZS5TdG9yYWdlRmlsZSwgV2luZG93cy5Gb3VuZGF0aW9uLCBDb250ZW50VHlwZSA9IFdpbmRvd3NSdW50aW1lXQpbdm9pZF1bV2luZG93cy5TdG9yYWdlLkZpbGVBY2Nlc3NNb2RlLCBXaW5kb3dzLkZvdW5kYXRpb24sIENvbnRlbnRUeXBlID0gV2luZG93c1J1bnRpbWVdClt2b2lkXVtXaW5kb3dzLkdsb2JhbGl6YXRpb24uTGFuZ3VhZ2UsIFdpbmRvd3MuRm91bmRhdGlvbiwgQ29udGVudFR5cGUgPSBXaW5kb3dzUnVudGltZV0KCiMgQ3JpYSBvIG1vdG9yIG5vIGlkaW9tYSBwZWRpZG87IHNlIG8gcGFjb3RlIG7Do28gZXN0aXZlciBpbnN0YWxhZG8sIGNhaSBwYXJhIG8KIyBpZGlvbWEgZG8gcGVyZmlsIGRvIHVzdcOhcmlvLiBTZW0gbmVuaHVtIG1vdG9yIOKGkiBlcnJvIGNsYXJvLgokZW5naW5lID0gJG51bGwKdHJ5IHsKICAkZW5naW5lID0gW1dpbmRvd3MuTWVkaWEuT2NyLk9jckVuZ2luZV06OlRyeUNyZWF0ZUZyb21MYW5ndWFnZShbV2luZG93cy5HbG9iYWxpemF0aW9uLkxhbmd1YWdlXTo6bmV3KCRMYW5nKSkKfSBjYXRjaCB7fQppZiAoLW5vdCAkZW5naW5lKSB7ICRlbmdpbmUgPSBbV2luZG93cy5NZWRpYS5PY3IuT2NyRW5naW5lXTo6VHJ5Q3JlYXRlRnJvbVVzZXJQcm9maWxlTGFuZ3VhZ2VzKCkgfQppZiAoLW5vdCAkZW5naW5lKSB7CiAgW0NvbnNvbGVdOjpFcnJvci5Xcml0ZUxpbmUoIm5vLW9jci1sYW5ndWFnZTogbmVuaHVtIHBhY290ZSBkZSBPQ1IgaW5zdGFsYWRvIHBhcmEgJyRMYW5nJyIpCiAgZXhpdCAzCn0KCmZvcmVhY2ggKCRwYXRoIGluIFtTeXN0ZW0uSU8uRmlsZV06OlJlYWRBbGxMaW5lcygkTWFuaWZlc3QpKSB7CiAgaWYgKFtzdHJpbmddOjpJc051bGxPcldoaXRlU3BhY2UoJHBhdGgpKSB7IGNvbnRpbnVlIH0KICB0cnkgewogICAgJGZpbGUgPSBBd2FpdCAoW1dpbmRvd3MuU3RvcmFnZS5TdG9yYWdlRmlsZV06OkdldEZpbGVGcm9tUGF0aEFzeW5jKCRwYXRoKSkgKFtXaW5kb3dzLlN0b3JhZ2UuU3RvcmFnZUZpbGVdKQogICAgJHN0cmVhbSA9IEF3YWl0ICgkZmlsZS5PcGVuQXN5bmMoW1dpbmRvd3MuU3RvcmFnZS5GaWxlQWNjZXNzTW9kZV06OlJlYWQpKSAoW1dpbmRvd3MuU3RvcmFnZS5TdHJlYW1zLklSYW5kb21BY2Nlc3NTdHJlYW1dKQogICAgJGRlY29kZXIgPSBBd2FpdCAoW1dpbmRvd3MuR3JhcGhpY3MuSW1hZ2luZy5CaXRtYXBEZWNvZGVyXTo6Q3JlYXRlQXN5bmMoJHN0cmVhbSkpIChbV2luZG93cy5HcmFwaGljcy5JbWFnaW5nLkJpdG1hcERlY29kZXJdKQogICAgJGJpdG1hcCA9IEF3YWl0ICgkZGVjb2Rlci5HZXRTb2Z0d2FyZUJpdG1hcEFzeW5jKCkpIChbV2luZG93cy5HcmFwaGljcy5JbWFnaW5nLlNvZnR3YXJlQml0bWFwXSkKICAgICRyZXN1bHQgPSBBd2FpdCAoJGVuZ2luZS5SZWNvZ25pemVBc3luYygkYml0bWFwKSkgKFtXaW5kb3dzLk1lZGlhLk9jci5PY3JSZXN1bHRdKQogICAgIyBQcmVzZXJ2YSBhIG9yZGVtIGRhcyBsaW5oYXMgKHRvcG/ihpJiYXNlKSwgY29tbyBvIFZpc2lvbi4KICAgICR0ZXh0ID0gKCRyZXN1bHQuTGluZXMgfCBGb3JFYWNoLU9iamVjdCB7ICRfLlRleHQgfSkgLWpvaW4gImBuIgogICAgW0NvbnNvbGVdOjpPdXQuV3JpdGVMaW5lKCR0ZXh0KQogICAgJHN0cmVhbS5EaXNwb3NlKCkKICB9IGNhdGNoIHsKICAgIFtDb25zb2xlXTo6T3V0LldyaXRlTGluZSgiIikKICB9CiAgW0NvbnNvbGVdOjpPdXQuV3JpdGVMaW5lKCJAQEVORElNR0BAIikKfQo='

// Códigos ISO 639-2 das faixas → BCP-47 do Windows.Media.Ocr.
const WIN_LANG: Record<string, string> = {
  eng: 'en',
  por: 'pt',
  spa: 'es',
  fre: 'fr',
  fra: 'fr',
  ger: 'de',
  deu: 'de',
  ita: 'it',
  jpn: 'ja'
}

export function winLang(code: string): string {
  return WIN_LANG[code.toLowerCase()] ?? 'en'
}

function cacheDir(): string {
  return joinPath(process.env.LOCALAPPDATA ?? process.env.TEMP ?? '.', 'LegendaAIpraMim')
}

const DELIM = '@@ENDIMG@@'
let resolved: string | null | undefined

/**
 * Escreve o script PowerShell no cache e devolve o caminho. Não compila nada —
 * o WinRT Windows.Media.Ocr está presente em qualquer Windows 10/11.
 * null = não é Windows.
 */
export async function resolveWinOcr(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  if (resolved !== undefined) return resolved
  const script = joinPath(cacheDir(), 'winocr-v1.ps1')
  await Bun.write(script, Buffer.from(WINOCR_PS1_B64, 'base64').toString('utf8'))
  logi('OCR do Windows pronto (Windows.Media.Ocr).')
  resolved = script
  return script
}

export async function hasWinOcr(): Promise<boolean> {
  return (await resolveWinOcr()) !== null
}

/** BMP 8-bit em tons de cinza (top-down), que o BitmapDecoder do Windows lê nativamente. */
function grayBmp(img: SubtitleImage): Uint8Array {
  const w = img.width
  const h = img.height
  const rowSize = (w + 3) & ~3 // linhas alinhadas a 4 bytes
  const pixelDataSize = rowSize * h
  const paletteSize = 256 * 4
  const dataOffset = 14 + 40 + paletteSize
  const fileSize = dataOffset + pixelDataSize
  const buf = new Uint8Array(fileSize)
  const dv = new DataView(buf.buffer)
  // BITMAPFILEHEADER
  buf[0] = 0x42 // 'B'
  buf[1] = 0x4d // 'M'
  dv.setUint32(2, fileSize, true)
  dv.setUint32(10, dataOffset, true)
  // BITMAPINFOHEADER
  dv.setUint32(14, 40, true)
  dv.setInt32(18, w, true)
  dv.setInt32(22, -h, true) // negativo = top-down (sem inverter as linhas)
  dv.setUint16(26, 1, true) // planos
  dv.setUint16(28, 8, true) // bits por pixel
  dv.setUint32(30, 0, true) // BI_RGB (sem compressão)
  dv.setUint32(34, pixelDataSize, true)
  dv.setInt32(38, 2835, true) // ~72 DPI
  dv.setInt32(42, 2835, true)
  dv.setUint32(46, 256, true) // cores na paleta
  // paleta em tons de cinza
  let off = 54
  for (let i = 0; i < 256; i++) {
    buf[off++] = i // B
    buf[off++] = i // G
    buf[off++] = i // R
    buf[off++] = 0 // reservado
  }
  // pixels (top-down)
  for (let y = 0; y < h; y++) {
    const row = dataOffset + y * rowSize
    for (let x = 0; x < w; x++) buf[row + x] = img.gray[y * w + x]
  }
  return buf
}

/** OCR de um lote de imagens numa única invocação do PowerShell (amortiza o startup). */
export async function winOcrChunk(
  script: string,
  lang: string,
  images: SubtitleImage[],
  tmpBase: string
): Promise<string[]> {
  const paths: string[] = []
  for (let j = 0; j < images.length; j++) {
    const p = `${tmpBase}-${j}.bmp`
    await Bun.write(p, grayBmp(images[j]))
    paths.push(p)
  }
  const manifest = `${tmpBase}.manifest.txt`
  await Bun.write(manifest, paths.join('\r\n'))
  const proc = Bun.spawn(
    ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, lang, manifest],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`OCR do Windows falhou (${code}): ${err.slice(0, 200) || 'sem detalhe'}`)
  }
  const segs = out.split(DELIM)
  return images.map((_, j) => (segs[j] ?? '').trim())
}
