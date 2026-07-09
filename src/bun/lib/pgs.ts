// Parser de PGS (Presentation Graphic Stream — legendas em imagem de Blu-ray,
// arquivo .sup). Decodifica cada legenda para uma imagem em tons de cinza
// (texto escuro sobre fundo branco) com timestamps, pronta para OCR.

export interface SubtitleImage {
  startMs: number
  endMs: number
  width: number
  height: number
  /** Cinza 8-bit (0=preto/texto, 255=branco/fundo), width*height bytes. */
  gray: Uint8Array
}

const u16 = (b: Uint8Array, o: number): number => (b[o] << 8) | b[o + 1]
const u32 = (b: Uint8Array, o: number): number =>
  b[o] * 0x1000000 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]

interface PgsObject {
  width: number
  height: number
  chunks: Uint8Array[]
}
interface CompObject {
  objectId: number
  x: number
  y: number
}
interface DisplaySet {
  pts: number
  image: { width: number; height: number; gray: Uint8Array } | null
}

/** RLE do PGS → índices de paleta (width*height). */
function decodeRle(data: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height)
  let i = 0
  let y = 0
  let p = 0
  while (i < data.length && y < height) {
    const b1 = data[i++]
    let runLen: number
    let color: number
    if (b1 !== 0) {
      color = b1
      runLen = 1
    } else {
      const b2 = data[i++]
      if (b2 === 0) {
        // fim de linha
        y++
        p = y * width
        continue
      }
      const kind = b2 & 0xc0
      if (kind === 0x00) {
        runLen = b2 & 0x3f
        color = 0
      } else if (kind === 0x40) {
        runLen = ((b2 & 0x3f) << 8) | data[i++]
        color = 0
      } else if (kind === 0x80) {
        runLen = b2 & 0x3f
        color = data[i++]
      } else {
        runLen = ((b2 & 0x3f) << 8) | data[i++]
        color = data[i++]
      }
    }
    for (let k = 0; k < runLen && p < out.length; k++) out[p++] = color
  }
  return out
}

/** Paleta: alpha por índice (só o alpha importa para OCR). */
function parsePalette(payload: Uint8Array): Uint8Array {
  const alpha = new Uint8Array(256)
  // payload: [paletteId, version, then entries de 5 bytes: id,Y,Cr,Cb,A]
  for (let o = 2; o + 4 < payload.length; o += 5) {
    const id = payload[o]
    alpha[id] = payload[o + 4]
  }
  return alpha
}

export function parsePgs(buffer: Uint8Array): SubtitleImage[] {
  const palettes = new Map<number, Uint8Array>()
  const objects = new Map<number, PgsObject>()
  const displaySets: DisplaySet[] = []

  let pcsPts = 0
  let pcsPaletteId = 0
  let pcsComp: CompObject[] = []

  let i = 0
  while (i + 13 <= buffer.length) {
    if (buffer[i] !== 0x50 || buffer[i + 1] !== 0x47) break // "PG"
    const pts = u32(buffer, i + 2)
    const type = buffer[i + 10]
    const size = u16(buffer, i + 11)
    const payload = buffer.subarray(i + 13, i + 13 + size)
    i += 13 + size

    if (type === 0x16) {
      // PCS
      pcsPts = pts
      pcsPaletteId = payload[9]
      const count = payload[10]
      pcsComp = []
      let o = 11
      for (let n = 0; n < count && o + 8 <= payload.length; n++) {
        const objectId = u16(payload, o)
        const cropped = (payload[o + 3] & 0x40) !== 0
        const x = u16(payload, o + 4)
        const y = u16(payload, o + 6)
        pcsComp.push({ objectId, x, y })
        o += cropped ? 16 : 8
      }
    } else if (type === 0x14) {
      // PDS
      palettes.set(payload[0], parsePalette(payload))
    } else if (type === 0x15) {
      // ODS
      const objectId = u16(payload, 0)
      const seq = payload[3]
      if (seq & 0x80) {
        // primeiro fragmento: data_len(3), width(2), height(2), rle...
        const width = u16(payload, 7)
        const height = u16(payload, 9)
        objects.set(objectId, { width, height, chunks: [payload.subarray(11)] })
      } else {
        objects.get(objectId)?.chunks.push(payload.subarray(4))
      }
    } else if (type === 0x80) {
      // END — finaliza o display set
      displaySets.push({ pts: pcsPts, image: renderDisplaySet(pcsComp, pcsPaletteId, palettes, objects) })
    }
  }

  // Converte display sets em legendas: cada imagem dura até o próximo display set.
  const subs: SubtitleImage[] = []
  for (let k = 0; k < displaySets.length; k++) {
    const ds = displaySets[k]
    if (!ds.image) continue
    const endPts = k + 1 < displaySets.length ? displaySets[k + 1].pts : ds.pts + 3 * 90000
    subs.push({
      startMs: Math.round(ds.pts / 90),
      endMs: Math.round(endPts / 90),
      width: ds.image.width,
      height: ds.image.height,
      gray: ds.image.gray
    })
  }
  return subs
}

/** Compõe os objetos do display set numa imagem cinza (bbox dos objetos). */
function renderDisplaySet(
  comp: CompObject[],
  paletteId: number,
  palettes: Map<number, Uint8Array>,
  objects: Map<number, PgsObject>
): { width: number; height: number; gray: Uint8Array } | null {
  if (comp.length === 0) return null
  const alpha = palettes.get(paletteId)
  if (!alpha) return null

  // bounding box da união dos objetos
  const rects = comp
    .map((c) => {
      const obj = objects.get(c.objectId)
      return obj ? { x: c.x, y: c.y, w: obj.width, h: obj.height, obj } : null
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
  if (rects.length === 0) return null

  const minX = Math.min(...rects.map((r) => r.x))
  const minY = Math.min(...rects.map((r) => r.y))
  const maxX = Math.max(...rects.map((r) => r.x + r.w))
  const maxY = Math.max(...rects.map((r) => r.y + r.h))
  const width = maxX - minX
  const height = maxY - minY
  if (width <= 0 || height <= 0 || width * height > 8_000_000) return null

  const gray = new Uint8Array(width * height).fill(255) // fundo branco
  for (const r of rects) {
    const rle = concat(r.obj.chunks)
    const idx = decodeRle(rle, r.obj.width, r.obj.height)
    for (let oy = 0; oy < r.obj.height; oy++) {
      for (let ox = 0; ox < r.obj.width; ox++) {
        const a = alpha[idx[oy * r.obj.width + ox]] ?? 0
        if (a === 0) continue
        const px = r.x - minX + ox
        const py = r.y - minY + oy
        gray[py * width + px] = 255 - a // opaco→escuro
      }
    }
  }
  return { width, height, gray }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]
  const total = chunks.reduce((s, c) => s + c.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}
