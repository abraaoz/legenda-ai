import SwiftUI
import Translation
import AppKit
import Foundation

// Tradução on-device do macOS (framework Translation, macOS 15+).
// Uso: appletranslate <src|""> <tgt> <inputFile>
// O inputFile tem os textos separados por NUL (\0); a saída (stdout) também.
// src vazio = detecção automática do idioma de origem.

@available(macOS 15.0, *)
struct BatchView: View {
  let src: String
  let tgt: String
  let texts: [String]
  var body: some View {
    let cfg = TranslationSession.Configuration(
      source: src.isEmpty ? nil : Locale.Language(identifier: src),
      target: Locale.Language(identifier: tgt))
    Color.clear.translationTask(cfg) { session in
      do {
        let reqs = texts.enumerated().map {
          TranslationSession.Request(sourceText: $1, clientIdentifier: String($0))
        }
        let resp = try await session.translations(from: reqs)
        var byId = [String: String]()
        for r in resp { if let id = r.clientIdentifier { byId[id] = r.targetText } }
        let out = (0..<texts.count).map { byId[String($0)] ?? texts[$0] }
        FileHandle.standardOutput.write(Data(out.joined(separator: "\u{0}").utf8))
      } catch {
        FileHandle.standardError.write(Data("ERR: \(error)".utf8))
        exit(2)
      }
      exit(0)
    }
  }
}

let args = CommandLine.arguments
guard args.count > 3, #available(macOS 15.0, *) else {
  FileHandle.standardError.write(Data("uso: appletranslate <src> <tgt> <file> (macOS 15+)".utf8))
  exit(1)
}
let data = FileManager.default.contents(atPath: args[3]) ?? Data()
let texts = (String(data: data, encoding: .utf8) ?? "").components(separatedBy: "\u{0}")
let app = NSApplication.shared
app.setActivationPolicy(.accessory) // sem ícone no Dock
let win = NSWindow(
  contentRect: NSRect(x: -2000, y: -2000, width: 1, height: 1),
  styleMask: [.borderless], backing: .buffered, defer: false)
win.contentView = NSHostingView(rootView: BatchView(src: args[1], tgt: args[2], texts: texts))
win.orderFrontRegardless()
app.run()
