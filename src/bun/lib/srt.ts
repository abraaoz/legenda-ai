// Parser/serializador de SRT. O ponto-chave: preservamos os timestamps
// intactos e só substituímos o texto, então a tradução nunca desincroniza.

export interface Cue {
  /** Linha de tempo, ex.: "00:00:01,500 --> 00:00:03,000". */
  time: string
  /** Texto da legenda (pode ter múltiplas linhas). */
  text: string
}

export function parseSrt(content: string): Cue[] {
  const blocks = content.replace(/\r\n/g, '\n').replace(/^﻿/, '').trim().split(/\n{2,}/)
  const cues: Cue[] = []
  for (const block of blocks) {
    const lines = block.split('\n')
    const timeIdx = lines.findIndex((l) => l.includes('-->'))
    if (timeIdx < 0) continue
    const time = lines[timeIdx].trim()
    const text = lines.slice(timeIdx + 1).join('\n').trim()
    if (text) cues.push({ time, text })
  }
  return cues
}

export function serializeSrt(cues: Cue[]): string {
  return (
    cues.map((cue, i) => `${i + 1}\n${cue.time}\n${cue.text}`).join('\n\n') + '\n'
  )
}
