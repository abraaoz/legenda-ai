// Helpers de caminho puramente em string — sem depender de nenhum módulo externo.
// Lidam com separadores "/" (Unix/macOS) e "\\" (Windows).

export function basename(p: string, ext?: string): string {
  const name = p.split(/[\\/]/).pop() ?? p
  if (ext && name.endsWith(ext)) return name.slice(0, name.length - ext.length)
  return name
}

export function extname(p: string): string {
  const name = basename(p)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}

export function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (idx < 0) return '.'
  if (idx === 0) return p.slice(0, 1)
  return p.slice(0, idx)
}

export function joinPath(...parts: string[]): string {
  const usesBackslash = parts.some((p) => p.includes('\\') && !p.includes('/'))
  const sep = usesBackslash ? '\\' : '/'
  return parts
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join(sep)
}
