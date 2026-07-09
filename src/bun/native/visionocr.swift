import Foundation
import Vision
import CoreGraphics

// Lê um PGM (P5) e devolve um CGImage em tons de cinza.
func loadPGM(_ path: String) -> CGImage? {
  guard let data = FileManager.default.contents(atPath: path) else { return nil }
  let b = [UInt8](data)
  var i = 0
  func isWS(_ c: UInt8) -> Bool { c == 32 || c == 10 || c == 9 || c == 13 }
  func skipWS() { while i < b.count && isWS(b[i]) { i += 1 } }
  func token() -> String { skipWS(); var s = ""; while i < b.count && !isWS(b[i]) { s.append(Character(UnicodeScalar(b[i]))); i += 1 }; return s }
  guard token() == "P5", let w = Int(token()), let h = Int(token()), Int(token()) != nil else { return nil }
  i += 1 // um whitespace após o maxval
  let n = w * h
  guard b.count - i >= n else { return nil }
  let px = Array(b[i..<i+n])
  guard let provider = CGDataProvider(data: Data(px) as CFData) else { return nil }
  return CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: w,
                 space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                 provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
}

let args = CommandLine.arguments
guard args.count > 2 else { exit(1) }
let lang = args[1]
for idx in 2..<args.count {
  autoreleasepool {
    var lines: [String] = []
    if let cg = loadPGM(args[idx]) {
      let req = VNRecognizeTextRequest()
      req.recognitionLevel = .accurate
      req.usesLanguageCorrection = true
      req.recognitionLanguages = [lang]
      try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
      if let obs = req.results {
        for o in obs.sorted(by: { $0.boundingBox.midY > $1.boundingBox.midY }) {
          if let t = o.topCandidates(1).first { lines.append(t.string) }
        }
      }
    }
    print(lines.joined(separator: "\n"))
    print("@@ENDIMG@@")
  }
}
