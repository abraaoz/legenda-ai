// Gerador do ícone do app (macOS), 1024x1024 PNG via CoreGraphics.
// Conceito: squircle com gradiente índigo→violeta (paleta do app), balão de
// legenda com duas linhas (clara = original, verde = traduzida) e um sparkle
// (IA). Uso: swiftc make-icon.swift -o /tmp/makeicon && /tmp/makeicon <out.png>
import AppKit
import CoreGraphics

let S = 1024
let cs = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(
  data: nil, width: S, height: S, bitsPerComponent: 8, bytesPerRow: 0,
  space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("ctx") }

let W = CGFloat(S)
func c(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) -> CGColor {
  CGColor(red: r / 255, green: g / 255, blue: b / 255, alpha: a)
}
func capsulePath(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGPath {
  CGPath(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerWidth: h / 2, cornerHeight: h / 2, transform: nil)
}
// Sparkle de 4 pontas (símbolo de IA), pontas curvas côncavas.
func sparklePath(_ cx: CGFloat, _ cy: CGFloat, _ R: CGFloat, _ inner: CGFloat) -> CGPath {
  let p = CGMutablePath()
  let r = R * inner
  let pts = [(0.0, 1.0), (1.0, 0.0), (0.0, -1.0), (-1.0, 0.0)] // N, E, S, W
  p.move(to: CGPoint(x: cx, y: cy + R))
  for i in 0..<4 {
    let (nx, ny) = pts[(i + 1) % 4]
    let ctrl = CGPoint(x: cx + r * (pts[i].0 + nx) * 0.5 * 1.1, y: cy + r * (pts[i].1 + ny) * 0.5 * 1.1)
    p.addQuadCurve(to: CGPoint(x: cx + R * nx, y: cy + R * ny), control: ctrl)
  }
  p.closeSubpath()
  return p
}

// 1. Fundo squircle com gradiente diagonal (índigo → violeta).
let margin: CGFloat = 96
let side = W - margin * 2
let bg = CGPath(roundedRect: CGRect(x: margin, y: margin, width: side, height: side),
                cornerWidth: 186, cornerHeight: 186, transform: nil)
ctx.saveGState()
ctx.addPath(bg)
ctx.clip()
let bgGrad = CGGradient(colorsSpace: cs, colors: [c(90, 107, 255), c(138, 63, 240)] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(bgGrad, start: CGPoint(x: margin, y: W - margin), end: CGPoint(x: W - margin, y: margin), options: [])
// brilho suave (canto superior esquerdo)
let glow = CGGradient(colorsSpace: cs, colors: [c(255, 255, 255, 0.30), c(255, 255, 255, 0)] as CFArray, locations: [0, 1])!
ctx.drawRadialGradient(glow, startCenter: CGPoint(x: 320, y: 760), startRadius: 0,
                       endCenter: CGPoint(x: 320, y: 760), endRadius: 640, options: [])
ctx.restoreGState()

// 2. Balão de legenda (com sombra suave), cauda apontando pra baixo.
let bx: CGFloat = 262, by: CGFloat = 373, bw: CGFloat = 500, bh: CGFloat = 344
let bubble = CGMutablePath()
bubble.addRoundedRect(in: CGRect(x: bx, y: by, width: bw, height: bh), cornerWidth: 86, cornerHeight: 86)
// cauda triangular arredondada (base no rodapé do balão, apex abaixo-esquerda)
let tail = CGMutablePath()
tail.move(to: CGPoint(x: 372, y: by + 8))
tail.addLine(to: CGPoint(x: 388, y: by - 66))
tail.addLine(to: CGPoint(x: 470, y: by + 8))
tail.closeSubpath()

ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -20), blur: 46, color: c(20, 10, 60, 0.34))
ctx.addPath(bubble)
ctx.addPath(tail)
ctx.setFillColor(c(255, 255, 255))
ctx.fillPath()
ctx.restoreGState()

// leve gradiente interno no balão (branco → lavanda clara)
ctx.saveGState()
let bubbleClip = CGMutablePath()
bubbleClip.addPath(bubble)
bubbleClip.addPath(tail)
ctx.addPath(bubbleClip)
ctx.clip()
let sheen = CGGradient(colorsSpace: cs, colors: [c(255, 255, 255), c(233, 236, 255)] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(sheen, start: CGPoint(x: bx, y: by + bh), end: CGPoint(x: bx, y: by), options: [])
ctx.restoreGState()

// 3. Duas linhas de legenda: superior clara (original), inferior verde (traduzida).
ctx.addPath(capsulePath(318, 588, 388, 58)) // linha 1 (mais longa, em cima)
ctx.setFillColor(c(199, 204, 236))
ctx.fillPath()
ctx.addPath(capsulePath(318, 476, 300, 58)) // linha 2 (mais curta, embaixo)
ctx.setFillColor(c(62, 207, 142))
ctx.fillPath()

// 4. Sparkle de IA (canto superior direito), com glow.
let sx: CGFloat = 772, sy: CGFloat = 742
let sGlow = CGGradient(colorsSpace: cs, colors: [c(255, 255, 255, 0.9), c(255, 255, 255, 0)] as CFArray, locations: [0, 1])!
ctx.drawRadialGradient(sGlow, startCenter: CGPoint(x: sx, y: sy), startRadius: 0,
                       endCenter: CGPoint(x: sx, y: sy), endRadius: 150, options: [])
ctx.addPath(sparklePath(sx, sy, 92, 0.34))
ctx.setFillColor(c(255, 255, 255))
ctx.fillPath()
// sparkle menor
ctx.addPath(sparklePath(676, 812, 34, 0.34))
ctx.setFillColor(c(255, 255, 255, 0.95))
ctx.fillPath()

// Exporta PNG.
guard let img = ctx.makeImage() else { fatalError("img") }
let rep = NSBitmapImageRep(cgImage: img)
guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("png") }
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon-1024.png"
try! png.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
