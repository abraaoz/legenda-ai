// Hook postBuild do Electrobun: compila os helpers nativos do macOS (OCR via
// Vision e tradução on-device via Translation) e os embute no app bundle, para
// que Macs SEM Xcode CLT também os tenham (sem depender de compilar sob demanda).
// Só faz algo no macOS com swiftc; em Linux/Windows (ou sem swiftc) é no-op e o
// app usa os fallbacks (Tesseract / Ollama / Azure).
export {}

const os = process.env.ELECTROBUN_OS
const buildDir = process.env.ELECTROBUN_BUILD_DIR

if (os !== 'macos' || !buildDir) {
  console.log('[native] não é macOS — pulando o bundle dos helpers nativos.')
  process.exit(0)
}

async function findBinary(name: string): Promise<string | null> {
  for (const dir of ['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin']) {
    const p = `${dir}/${name}`
    if (await Bun.file(p).exists()) return p
  }
  return null
}

const swiftc = await findBinary('swiftc')
if (!swiftc) {
  console.log('[native] swiftc não encontrado — o app usará compile-on-demand.')
  process.exit(0)
}

// Acha o .app dentro do diretório de build.
let appDir: string | undefined
for await (const entry of new Bun.Glob('*.app').scan({
  cwd: buildDir,
  onlyFiles: false,
  absolute: true
})) {
  appDir = entry
  break
}
if (!appDir) {
  console.error('[native] .app não encontrado em', buildDir)
  process.exit(0)
}

// Helpers a compilar: nome do binário embutido → fonte Swift.
const HELPERS: Array<{ name: string; src: string }> = [
  { name: 'visionocr', src: 'src/bun/native/visionocr.swift' },
  { name: 'appletranslate', src: 'src/bun/native/appletranslate.swift' }
]

for (const { name, src } of HELPERS) {
  const out = `${appDir}/Contents/Resources/app/${name}`
  console.log(`[native] compilando ${src} → ${out}`)
  const proc = Bun.spawn([swiftc, '-O', src, '-o', out], { stdout: 'inherit', stderr: 'inherit' })
  if ((await proc.exited) !== 0) {
    console.error(`[native] falha ao compilar ${name}.`)
    process.exit(1)
  }
}
console.log('[native] helpers nativos embutidos no app ✅')

// Linha de contato no painel "Sobre" (About) — o painel padrão do macOS exibe
// NSHumanReadableCopyright abaixo da versão, com estilo adaptável a light/dark.
// O Electrobun regenera o Info.plist a cada build, então setamos aqui.
const aboutLine = 'Abraão Zaidan · abraao.zaidan@gmail.com'
const plistPath = `${appDir}/Contents/Info.plist`
const plutil = Bun.spawn(
  ['plutil', '-replace', 'NSHumanReadableCopyright', '-string', aboutLine, plistPath],
  { stdout: 'inherit', stderr: 'inherit' }
)
if ((await plutil.exited) !== 0) {
  console.error('[native] falha ao gravar NSHumanReadableCopyright no Info.plist.')
  process.exit(1)
}
console.log('[native] contato adicionado ao About ✅')
