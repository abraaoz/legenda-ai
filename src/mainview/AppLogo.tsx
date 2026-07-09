// Logo do app em SVG — mesma arte do ícone (scripts/make-icon.swift):
// squircle índigo→violeta, balão de legenda com 2 linhas (clara=original,
// verde=traduzida) e um sparkle de IA. Vetorial, nítido em qualquer tamanho.

/** Sparkle de 4 pontas com laterais côncavas (coordenadas SVG, y para baixo). */
function sparkle(cx: number, cy: number, R: number, k = 0.34): string {
  const r = R * k
  const o: [number, number][] = [
    [0, -1], // N
    [1, 0], // E
    [0, 1], // S
    [-1, 0] // W
  ]
  let d = `M ${cx} ${cy - R} `
  for (let i = 0; i < 4; i++) {
    const cur = o[i]
    const nxt = o[(i + 1) % 4]
    const vx = cx + (cur[0] + nxt[0]) * 0.55 * r
    const vy = cy + (cur[1] + nxt[1]) * 0.55 * r
    d += `Q ${vx} ${vy} ${cx + nxt[0] * R} ${cy + nxt[1] * R} `
  }
  return d + 'Z'
}

export function AppLogo({ size = 34 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Legenda AI pra mim"
    >
      <defs>
        <linearGradient id="lg-bg" x1="96" y1="96" x2="928" y2="928" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#5A6BFF" />
          <stop offset="1" stopColor="#8A3FF0" />
        </linearGradient>
        <linearGradient id="lg-bubble" x1="512" y1="307" x2="512" y2="651" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#E9ECFF" />
        </linearGradient>
        <radialGradient id="lg-glow" cx="320" cy="264" r="620" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.28" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
        <clipPath id="lg-clip">
          <rect x="96" y="96" width="832" height="832" rx="186" />
        </clipPath>
        <filter id="lg-shadow" x="-20%" y="-20%" width="140%" height="150%">
          <feDropShadow dx="0" dy="10" stdDeviation="16" floodColor="#140A3C" floodOpacity="0.34" />
        </filter>
      </defs>

      {/* fundo squircle + brilho */}
      <rect x="96" y="96" width="832" height="832" rx="186" fill="url(#lg-bg)" />
      <rect x="96" y="96" width="832" height="832" fill="url(#lg-glow)" clipPath="url(#lg-clip)" />

      {/* balão de legenda (com cauda e sombra) */}
      <g filter="url(#lg-shadow)">
        <path
          d="M 388 717 L 372 643 L 470 643 Z"
          fill="url(#lg-bubble)"
        />
        <rect x="262" y="307" width="500" height="344" rx="86" fill="url(#lg-bubble)" />
      </g>

      {/* duas linhas: original (clara) e traduzida (verde) */}
      <rect x="318" y="378" width="388" height="58" rx="29" fill="#C7CCEC" />
      <rect x="318" y="490" width="300" height="58" rx="29" fill="#3ECF8E" />

      {/* sparkle de IA */}
      <path d={sparkle(772, 282, 92)} fill="#FFFFFF" />
      <path d={sparkle(676, 212, 34)} fill="#FFFFFF" fillOpacity="0.95" />
    </svg>
  )
}
