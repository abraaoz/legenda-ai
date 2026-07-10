# CLAUDE.md — Legenda AI pra mim

Guia para agentes trabalhando neste repositório. Leia antes de mexer no código.

## O que é

App **desktop** (macOS/Windows/Linux) para **baixar e traduzir legendas** de vídeos.
Dois modos:

- **OpenSubtitles** (padrão): busca legenda pelo *hash* do vídeo (sincronia exata) e baixa o `.srt`. Requer uma API key gratuita do OpenSubtitles.
- **Legendas por Tradução** (o termo "Modo AI" foi aposentado): para vídeos com legenda **embutida** (ex.: MKV), detecta as faixas, extrai a legenda (100% sincronizada) e a **traduz preservando os timestamps**. Três motores plugáveis (`settings.translationProvider`): **Ollama** (LLM local, offline, grátis), **Azure AI Translator** (nuvem; credenciais chave/região/endpoint em settings, NUNCA no código) ou **Apple** (tradução on-device do macOS 15+, offline, grátis, sem limite de taxa — via `appletranslate.swift` + `apple.ts`, `createAppleTranslator(sourceCode, targetCode)`; precisa do idioma de ORIGEM, ao contrário dos outros; `aiTranslateEmbedded` passa `sourceLanguage`). O engine é uma `BatchTranslator` (`{ batchSize, run }`) em `translate.ts`; `createOllamaTranslator` (batchSize 20) / `createAzureTranslator` (batchSize 100) / `createAppleTranslator` (batchSize 80, async pois resolve o helper) produzem uma; `aiTranslateEmbedded` usa `translate.batchSize`. Azure retorna traduções na mesma ordem da entrada (não precisa do prompt numerado do Ollama), aceita até 1000 textos/50k chars por request (lotes grandes = menos requisições = evita o **429** de rate limit) e o cliente faz **backoff/retry no 429** respeitando `Retry-After`. **Windows NÃO tem tradução on-device dedicada** (pesquisado jul/2026): as Windows AI APIs incluem OCR/Phi Silica/etc., mas "Live Translation" é *"Not yet supported"*; o único caminho seria promptar o Phi Silica (SLM genérico, exige Copilot+ PC/RTX + Windows App SDK), então decidiu-se **não implementar** — no Windows a tradução fica com Ollama/Azure. (O **OCR** do Windows, esse sim, existe in-box: `Windows.Media.Ocr`, ver seção de OCR.)

## Restrição inegociável: NADA de Node

O usuário **proíbe Node e todo o ecossistema Node**. Sempre:

- **Runtime e tooling = Bun.** Use `bun`, `bunx` (nunca `npx`), `bun install`, `bun build`.
- **APIs Bun-nativas**, nunca `node:*`: `Bun.file`, `Bun.write`, `Bun.spawn`, `Bun.Glob`, `fetch` global. Helpers de caminho são feitos à mão em `src/bun/lib/paths.ts` (nada de `node:path`).
- **Sem Electron** (o processo main do Electron É um runtime Node embutido). Usamos **Electrobun**, que roda em Bun.
- Evite até o nome "node" em variáveis (ex.: não use `NODE_ENV`).

Esta é uma preferência forte e permanente do usuário — vale para qualquer projeto, não só este.

## Stack

- **Bun** (runtime + gerenciador de pacotes)
- **Electrobun** ~1.18 — janela via webview nativo do SO, RPC tipado main↔UI, bundler, code signing e auto-update (bsdiff) embutidos
- **React 19 + TypeScript 7** — UI, bundlada pelo **próprio Electrobun** (`Bun.build`), **não** por Vite
- **ffmpeg/ffprobe** — detectar/extrair legendas embutidas (dependência externa)
- **Ollama** — tradução local de legendas (dependência externa)

Dependências npm: apenas `electrobun`, `react`, `react-dom` (+ tipos e `typescript` em dev).

## Arquitetura

```
src/
├── bun/                    # PROCESSO PRINCIPAL (Bun) — acesso a disco, rede, diálogos
│   ├── index.ts               # BrowserView.defineRPC(handlers) + new BrowserWindow(...)
│   └── lib/
│       ├── opensubtitles.ts   # hash (Bun.file.slice), busca, download, validateApiKey
│       ├── ffmpeg.ts          # resolveBinary + listEmbeddedSubtitles + extractEmbedded
│       ├── ollama.ts          # cliente do Ollama (listModels, chat)
│       ├── vision.ts          # OCR do macOS (Vision) — compila helper Swift sob demanda
│       ├── azure.ts           # cliente do Azure AI Translator (azureTranslate/azureValidate)
│       ├── translate.ts       # motores plugáveis + extrai/traduz/retoma preservando timestamps
│       ├── srt.ts             # parse/serialize de SRT
│       ├── files.ts           # listVideosInFolder (Bun.Glob, recursivo)
│       ├── logger.ts          # log verboso do backend (buffer + envio à UI)
│       ├── dependencies.ts    # checkDependencies() (ffmpeg/ffprobe/Ollama/escrita)
│       ├── settings.ts        # persistência (Bun.file/Bun.write) por SO
│       ├── cast/              # "Tocar na TV" (Chromecast/Google Cast)
│       │   ├── discover.ts        # mDNS (Bun.udpSocket) + localIp
│       │   ├── client.ts          # protocolo CASTV2 (protobuf+TLS)
│       │   ├── server.ts          # HTTP de mídia (range) + SRT→VTT
│       │   └── manager.ts         # orquestra sessão única + status
│       └── paths.ts           # basename/dirname/extname/joinPath (sem node:path)
├── mainview/               # UI (React, roda no webview)
│   ├── index.html             # carrega views://mainview/index.{js,css}
│   ├── index.tsx  App.tsx  index.css
│   └── api.ts                 # cliente RPC (Electroview) + assinatura de progresso
├── shared/
│   ├── types.ts               # tipos de domínio
│   ├── version.ts             # fonte ÚNICA da versão (importa package.json)
│   └── rpc.ts                 # contrato RPC tipado (LegendaRPC)
└── electrobun-shims.d.ts   # declare module 'three'/'babylonjs' (ver Gotchas)
electrobun.config.ts        # app (name/identifier/version) + build (bun/views/copy/mac.icons)
assets/                     # ícone do app: icon-1024.png (master) + icon.iconset/
scripts/make-icon.swift     # gerador do ícone (CoreGraphics)
```

**Ícone do app** (Dock + About): balão de legenda com 2 linhas (clara=original, verde=traduzida) + sparkle de IA, sobre squircle com gradiente índigo→violeta. Gerado por `scripts/make-icon.swift` (CoreGraphics, 1024px) → `assets/icon-1024.png`; os 10 tamanhos do `assets/icon.iconset/` saem por `sips`. `electrobun.config.ts` aponta `build.mac.icons: 'assets/icon.iconset'` e o Electrobun converte para `Contents/Resources/AppIcon.icns` via `iconutil` no build (`CFBundleIconFile=AppIcon`). Para regenerar: `swiftc -O scripts/make-icon.swift -o /tmp/makeicon && /tmp/makeicon assets/icon-1024.png` e refazer o iconset com `sips`. **macOS cacheia ícone**: após rebuild, `touch` no `.app` + `lsregister -f` + `killall Dock` força o refresh (senão o Dock mostra o antigo). (Win/Linux: `build.win.icon` `.ico` / `build.linux.icon` `.png` — ainda não feitos.)

**RPC:** `BrowserView.defineRPC<LegendaRPC>` no Bun; `Electroview.defineRPC<LegendaRPC>` na view. A UI chama `api.*` (em `src/mainview/api.ts`), que faz `electroview.rpc.request.<fn>()`. Bun→UI usa **mensagens** (`rpc.send.*`): `translateProgress` (progresso da tradução) e `log` (cada linha do log do backend). Ambas são consumidas por assinaturas em `api.ts` (`onTranslateProgress`, `onLog`). Cada handler RPC é embrulhado por `logged()` (loga início/args/resultado/erro).

**Coluna de Log:** a UI tem uma coluna fixa à direita (sempre visível) que mostra o log verboso do backend em tempo real. `logger.ts` mantém um buffer (a UI pega o histórico via `getLogBuffer`) e empurra cada linha por mensagem.

**About (Sobre):** o menu usa o role `about` → `orderFrontStandardAboutPanel:` nativo, que mostra nome/versão + `NSHumanReadableCopyright` (linha de contato `Abraão Zaidan · abraao.zaidan@gmail.com`). O Electrobun **regenera o Info.plist a cada build**, então essa chave é gravada no **postBuild** (`scripts/bundle-vision.ts`, via `plutil -replace`) — não editar o Info.plist buildado à mão (some no próximo build). Preferido a um `Credits.rtf` porque a linha do plist é estilizada pelo painel e **adapta a light/dark** automaticamente.

**Permissões macOS:** o app **não precisa de Accessibility** (não controla o computador). Acesso a arquivos vem do seletor nativo (`Utils.openFileDialog`). O checklist inclui um teste **funcional** de gravação (a "permissão" que importa para salvar `.srt`) — TCC não é consultável diretamente. (O `claude.app` que aparece em Accessibility é o Claude Code, não este app.)

## Comandos

```bash
bun install
bun run dev            # electrobun dev: build de dev + abre o app
bun run dev:watch      # idem, com hot-reload
bun run typecheck      # bunx tsc --noEmit
bun run build          # build de dev (build/dev-<os>-<arch>/<App>.app)
bun run build:stable   # distribuição em artifacts/ (.dmg, .app.tar.zst, update.json)
```

Distribuição é **por-plataforma-host** (build no próprio SO). CI: `.github/workflows/build.yml` roda `build:stable` em runners nativos (macOS arm64 em `macos-15` — precisa do SDK do macOS 15 pro helper Apple; Windows; Linux) e publica um Release ao dar push de uma tag `v*` **ou** por dispatch manual com o input `release_tag`. **Sem macOS Intel** (runners `macos-13` escassos/em descontinuação travavam a fila).

**Auto-update** (Electrobun, embutido): `electrobun.config.ts#release.baseUrl` aponta pra `https://github.com/abraaoz/legenda-ai/releases/latest/download` (o GitHub redireciona `latest/download/<arquivo>` pro release mais novo; nossos artefatos não têm versão no nome, ex. `stable-macos-arm64-update.json`, então sempre pega o mais recente). `generatePatch: false` por ora (baixa o pacote inteiro; sem bsdiff). O menu **"Buscar atualizações…"** (`action: 'check-for-updates'` em `index.ts`) roda `Updater.checkForUpdate → downloadUpdate → applyUpdate` (aplica e reinicia); `Updater.onStatusChange` joga o status na coluna de Log. O Updater lê `Contents/Resources/version.json` (tem `baseUrl`/`channel`/`version`) do app **real** (dentro do tarball auto-extrator, não do stub). **Só canais `stable`/`canary` atualizam — `dev` é ignorado** (então não dá pra testar no `bun run dev`; precisa de um `.dmg` stable instalado + um release mais novo). App **não assinado** pode ser re-quarentenado pelo Gatekeeper ao atualizar — assinar/notarizar resolve.

## Dependências externas

Detectadas em `dependencies.ts` e exibidas num **checklist visual** nas Configurações.

- **NÃO use `which`.** Um `.app` aberto pelo Finder tem PATH mínimo (sem `/opt/homebrew/bin`), então `which ffmpeg` falharia mesmo instalado. Use `resolveBinary()` (em `ffmpeg.ts`), que procura por **caminho absoluto** no PATH **+** `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, `/snap/bin`.
- **ffmpeg/ffprobe**: `brew install ffmpeg`. Sem eles, a detecção/extração de embutidas fica indisponível (o app avisa, não quebra).
- **Ollama**: servidor em `http://localhost:11434` + um modelo (`ollama pull llama3.1` ou `gemma2:2b`). Detectado via HTTP (`/api/tags`).

## Gotchas (aprendidos na marra)

- **OpenSubtitles `User-Agent`**: precisa ser o **nome EXATO do consumer registrado** + versão (ex.: `legendaAIpramim v1.1.0`; a validação é pelo NOME, a versão acompanha o release), senão a API responde **403 "User-Agent header is wrong"** na busca/download. Está em `USER_AGENT` (`opensubtitles.ts`), montado a partir de `shared/version`.
- **Versão em fonte única**: a versão vive **só** no `package.json`; `src/shared/version.ts` faz `import { version } from '../../package.json'` e re-exporta. `electrobun.config.ts` (`app.version`) e o `USER_AGENT` importam de lá. **Para bumpar, edite APENAS o `package.json`** — nada de hardcode em `.ts`. (Bun/TS resolvem o named import do JSON nativamente; `resolveJsonModule` já ligado.)
- **OpenSubtitles: query params em ordem alfabética.** `GET /subtitles` com parâmetros fora de ordem responde **301** para a URL ordenada. Sempre chamar `url.searchParams.sort()` antes do fetch.
- **OpenSubtitles: `/infos/languages` NÃO valida a api-key** (responde 200 pra qualquer valor) — por isso `validateApiKey` bate em `/subtitles` (que checa de fato). O **403 "You cannot consume this service"** = api-key errada/inválida; erro clássico é colar a **URL** da página de consumers em vez da **API Key** (string). `validateApiKey` rejeita valores com `http`/`/`/espaço.

- **OpenSubtitles: contribuir/upload NÃO existe na REST API** (`api.opensubtitles.com` só tem login/busca/download/ai-translation; pesquisado jul/2026). O upload é só pela **API legada XML-RPC** (`api.opensubtitles.org`), fluxo `LogIn → TryUploadSubtitles → UploadSubtitles` — `TryUpload` checa por hash se já existe (idempotência nativa). Exige **usuário+senha** do OpenSubtitles (não a api-key) e mexe com política de legendas auto-traduzidas. Decidiu-se **não implementar** por ora.
- **Electrobun distribui o código-fonte como `.ts`** (o `exports` do pacote aponta para `.ts`), então o `tsc` acaba typecheckando o interno dele — que importa libs 3D opcionais sem tipos. Por isso existe `src/electrobun-shims.d.ts` com `declare module 'three'` / `'babylonjs'`.
- **`rpc.send` existe em runtime mas não no tipo público** (`RPCWithTransport`). Para enviar mensagens do Bun para a UI, use o helper `sendProgress` em `index.ts` (faz o cast). `rpc.request.*` é tipado normalmente.
- **`maxRequestTime` precisa ser alto nos DOIS lados do RPC.** O default do rpc-anywhere é ~1s. Operações demoradas — abrir `openFileDialog` (o usuário leva tempo escolhendo) e a tradução por IA (minutos) — estouram esse default. Está setado em `3_600_000` tanto no `BrowserView.defineRPC` (bun, `src/bun/index.ts`) quanto no `Electroview.defineRPC` (view, `src/mainview/api.ts`). **Sintoma se esquecer o lado view:** clicar em "Selecionar vídeos" abre o diálogo, mas a promise rejeita com "RPC request timed out" e nada aparece na tela. O `chat()` do Ollama também usa `AbortSignal.timeout(300_000)` porque o **primeiro lote carrega o modelo** na memória.
- **`openFileDialog` bloqueia a thread principal do Bun** enquanto o painel está aberto (é uma chamada FFI síncrona). É aceitável (o diálogo é modal), mas reforça a necessidade do `maxRequestTime` alto no lado view.
- **Atalhos de edição (Cmd+V/C/X/A)** só funcionam nos inputs se houver um **menu Edit nativo** com os roles `paste/copy/cut/selectAll` (no macOS os atalhos são roteados pela responder chain via `NSMenuItem`). Configurado com `ApplicationMenu.setApplicationMenu([...])` em `index.ts`. Também há botões "Colar" na UI usando `Utils.clipboardReadText()` (RPC `readClipboard`) como alternativa.
- **Arrastar a janela (title bar `hiddenInset`)**: `-webkit-app-region: drag` (do Electron/Chromium) **não** funciona na webview nativa do Electrobun. Use a classe **`electrobun-webkit-app-region-drag`** no elemento arrastável e **`electrobun-webkit-app-region-no-drag`** nos botões/interativos dentro dele (o preload do Electrobun escuta mousedown e chama `startWindowMove`). Só a classe (ou `style` inline com `app-region`) é detectada — regra de CSS em folha de estilo é ignorada.
- **Tradução preserva timestamps** por construção: parseia o SRT em cues, manda só os textos numerados ao LLM em lotes, e remonta com os **mesmos** timestamps. Se o modelo devolver algo faltando, mantém o texto original (nunca desincroniza).
- **Tradução idempotente e retomável** (`translate.ts`): grava o `.<idioma-alvo>.srt` **a cada lote** (salvamento incremental; nome "limpo" que o player carrega sozinho — `targetSrtPath`). Guarda contra colisão origem==destino (mesmo idioma) lançando erro. Ao (re)iniciar, lê o parcial existente e **valida o alinhamento por timestamps** contra a fonte; se alinhar, retoma de `parsed.length`; senão recomeça. Completo → retorna sem trabalho (idempotente). Retorna `{savedPath, done, total}`.
- **Cancelamento**: `index.ts` guarda um `AbortController` por caminho (`activeTranslations`). `cancelTranslate({path})` chama `.abort()`; o loop faz `break` entre lotes (não lança) e o `chat()` do Ollama combina o timeout com o signal via `AbortSignal.any` (aborta a requisição em andamento). Cancelar **mantém o parcial em disco** (os lotes já concluídos).
- **UI de status**: `getTranslationStatus(path,index,targetCode)` compara falas traduzidas (arquivo `.<idioma-alvo>.srt`) vs. total da fonte (conta via `extractEmbeddedToString`, sem escrever). A UI mostra por faixa: **Traduzir** (0), **Continuar done/total** (parcial, botão âmbar), **✔ Traduzido** (completo). Recalcula ao analisar, ao salvar settings (troca de idioma) e após traduzir. Barra de progresso via mensagem `translateProgress`.
- **Settings** ficam num JSON por SO: macOS `~/Library/Application Support/LegendaAIpraMim/`, Windows `%APPDATA%\LegendaAIpraMim\`, Linux `~/.config/legenda-ai-pra-mim/`. **NÃO** rodar `saveSettings`/`rm` nesse caminho real em testes (sobrescreve a config do usuário) — testar com um path de scratch. Há **Exportar/Importar** (RPC `exportSettings`/`importSettings`) para `legenda-ai-settings.json`; import faz merge sobre a config atual. O Electrobun só tem diálogo de **abrir** (`Utils.openFileDialog`) — o "Salvar como" do export é feito via `Bun.spawn` em `savedialog.ts` (osascript/zenity/PowerShell), evitando lib FFI extra (o `nativefiledialog-for-bun` funcionaria, mas o caminho FFI roda no processo Bun, que não é o da GUI no Electrobun).
- **Seleção por pasta** (`files.ts`) é **recursiva** e **case-insensitive** (pega `.MKV`, subpastas etc.) via `Bun.Glob`.
- **Legendas em imagem vs texto**: faixas embutidas podem ser **texto** (subrip/ass/mov_text… → `isText:true`) ou **imagem/bitmap** (PGS `hdmv_pgs_subtitle`, VobSub `dvd_subtitle` → `isText:false`), comuns em Blu-ray. ffmpeg **não** converte imagem→texto — precisa de **OCR**. `TEXT_SUB_CODECS` em `ffmpeg.ts` classifica.
- **OCR de PGS (`pgs.ts` + `ocr.ts` + `vision.ts`)**: parser próprio de PGS (`.sup`) em TypeScript — lê segmentos (PCS/PDS/ODS/END), decodifica o RLE, compõe a imagem e renderiza tons de cinza (texto escuro/fundo branco, via alpha da paleta) com timestamps. `ocrPgsToSrt` extrai o `.sup` (ffmpeg `-c:s copy`) e escolhe o **engine**:
  - **macOS (padrão): Vision** (`vision.ts`). Um helper Swift (`src/bun/native/visionocr.swift`) lê PGM e roda `VNRecognizeTextRequest` (`.accurate` + correção de linguagem). Processa **em lote** (~20 imgs/invocação → ~93ms/img) — mais rápido E muito melhor que o Tesseract (corrige `snot→shot`, `nave→have`, `Jonnson→Johnson`, brackets etc.). O binário é resolvido nesta ordem: (1) **embutido no app** em `Contents/Resources/app/visionocr` (compilado no build pelo hook **postBuild** `scripts/bundle-vision.ts`, que roda no macOS com swiftc — inclusive no CI), (2) cache `~/Library/Caches/LegendaAIpraMim/visionocr-v1`, (3) **compila sob demanda** (o Swift também vai embutido em base64 em `vision.ts`). Assim funciona em Macs sem Xcode CLT. **Ao assinar/notarizar (futuro), o helper precisa ser assinado também.**
  - **Windows (padrão): Windows.Media.Ocr** (`winocr.ts`). API WinRT nativa, em qualquer Win10/11, **sem compilar nada**: um helper **PowerShell** (`src/bun/native/winocr.ps1`, embutido em base64) usa `OcrEngine` via projeções WinRT (`Add-Type System.Runtime.WindowsRuntime` + helper `Await` para os `IAsyncOperation<T>`). Não há tier de compilação/bundle — o `.ps1` é escrito no cache (`%LOCALAPPDATA%\LegendaAIpraMim\winocr-v1.ps1`) e rodado (`powershell -NoProfile -ExecutionPolicy Bypass -File`). Entrada: cada imagem PGS vira um **BMP 8-bit grayscale top-down** (`grayBmp`, que o `BitmapDecoder` lê nativamente) + um manifesto (1 caminho/linha); saída delimitada por `@@ENDIMG@@` (igual ao Vision). Processa em lote (20/invocação) para amortizar o startup do PowerShell. **NÃO foi testado em Windows real** (validado só o encode do BMP via `sips`/`file` no macOS); a lógica WinRT/PowerShell precisa de verificação numa máquina Windows.
  - **Fallback: Tesseract** (Linux, ou sem engine nativo): upscale 2x + `--psm 6` + `cleanOcrText` (corrige "I" lido como "|").
  `hasOcr()` = Vision **ou** Windows.Media.Ocr **ou** Tesseract; `VideoInfo.ocrAvailable` reflete isso. Validado contra um Blu-ray real (Twin Peaks): 1105 falas. `translate.ts#produceSourceSrt` decide texto (ffmpeg) vs imagem (OCR). A tradução de imagem tem 2 fases (`translateProgress.phase = 'ocr' | 'translate'`). Tesseract entra no checklist e em `VideoInfo.tesseractAvailable`. Idioma extra: `brew install tesseract-lang`.
- **OCR retomável/idempotente**: `ocrPgsToSrt` grava o `.srt` a cada 10 imagens e mantém um marcador **`<srt>.part`** enquanto incompleto. Retoma pela primeira imagem com `startMs` maior que o último cue gravado; se já passou de todas, retorna rápido e apaga o marcador. Cancelar (via `signal`) mantém o parcial + marcador e **lança** (não deixa traduzir fonte incompleta). O `.sup` é **cacheado** em `$TMPDIR/legenda-ocr-<size>-<index>.sup` porque extrair do MKV varre o container inteiro (lento, ~90s). `produceSourceSrt` só reusa o `.srt` de origem se **não** houver marcador `.part`.
- **Tocar na TV (Chromecast / Google Cast)** — `src/bun/lib/cast/`, tudo em Bun nativo (sem lib Node). Fluxo: descobrir → conectar → servir mídia → LOAD com legenda VTT → controles. **Validado ponta-a-ponta num Chromecast real.** Botão "📺 Tocar na TV" no card (escolhe dispositivo + uma legenda `.srt` externa); barra de status/controle no topo (⏸/▶/⏹ + progresso). RPC: `castDiscover`/`castStart`/`castControl` + mensagem `castStatus`. **Só UMA sessão ativa** (o `manager` encerra a anterior). **Aprendizados que custaram caro (não regredir):**
  - **`socket.write` do Bun NÃO bufferiza** — pode escrever parcial (backpressure, retorna `< length`) e o resto é **descartado** (diferente do Node). O `client.ts` tem uma **fila de saída (outbox)** que escoa no evento `drain`; sem isso, o CONNECT/LAUNCH somem e o handshake falha silenciosamente (sintoma: só heartbeat PONG responde). Foi ISSO que travou a implementação por horas.
  - **CONNECT precisa de `senderInfo`** completo (nos moldes do pychromecast) — firmware novo manda `{"type":"CLOSE"}` no canal se o CONNECT for cru `{type:CONNECT}`. Ver `CONNECT_PAYLOAD`.
  - **source id único por conexão** (`sender-<rand>`) — reusar `sender-0` faz o receiver fechar como duplicata.
  - **IP da LAN**: detecte conectando um UDP socket **ao próprio dispositivo** (`localIp(deviceHost)`), NÃO a `8.8.8.8` — com VPN/Tailscale ativa a rota default é CGNAT `100.64.x`, que a TV não alcança (o servidor de mídia ficaria inacessível).
  - **Descoberta com VPN**: enumera as interfaces via **`/sbin/ifconfig` (caminho ABSOLUTO** — .app do Finder tem PATH mínimo) e roda a query mDNS em cada IP de **LAN privada** (192.168/10/172.16-31), ignorando loopback e CGNAT. macOS ocupa a 5353, então a query pede resposta **unicast** (bit QU no QCLASS).
  - **Legenda**: o Cast só aceita **WebVTT** (o `server.ts` converte SRT→VTT: `WEBVTT\n\n` + vírgula→ponto nos tempos) e exige **CORS** (`Access-Control-Allow-Origin: *`) na resposta da legenda. O vídeo é servido com **byte-range** (206) pra permitir seek. Sem transcode: se o codec não for suportado pela TV (ex.: HEVC/AC3 em MKV), não toca.

## Como validar mudanças

- `bun run typecheck` sempre.
- Prefira **testar as funções de lib direto no runtime** com `bun -e '...'` (foi assim que validamos o hash contra referência, `ffprobe`/`ffmpeg` de verdade, e a tradução via Ollama).
- Para conferir a UI, `bun run build` e `open` do `.app` (ou `bun run dev`). Cliques na janela GUI não são automatizáveis aqui, e `screencapture` é bloqueado por permissão — valide a lógica no runtime e diga com honestidade o que não deu para ver na tela.

## Contexto da máquina do usuário (pode mudar)

ffmpeg/ffprobe 8.x em `/opt/homebrew/bin`. Ollama.app rodando em `:11434` com `llama3.1:8b` e `gemma2:2b` instalados (`llama3.1:8b` traduz melhor; `gemma2:2b` é mais rápido).
