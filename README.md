# Legenda AI pra mim 🎬

App desktop (macOS, Windows e Linux) feito com **Bun + [Electrobun](https://electrobun.dev)**
— sem Node, sem Electron/Chromium — que baixa legendas sincronizadas para seus
arquivos de vídeo. Usa o *hash* do OpenSubtitles para achar a legenda com
sincronia exata (e cai para busca por nome quando não há match).

## Stack

- **Runtime: Bun** — toda a lógica roda no processo Bun (`Bun.file`, `fetch`, `Bun.write`)
- **Framework: Electrobun** — webview nativo do SO, RPC tipado main↔UI, bundler,
  assinatura/notarização e **auto-update** (patches bsdiff) embutidos
- **UI: React 19 + TypeScript**, bundlada pelo Electrobun (Bun.build)
- **Diálogo de arquivo nativo:** `Utils.openFileDialog` do Electrobun
- **Distribuição:** `.dmg` (macOS), instalador (Windows), pacote (Linux) + tarball de update

## Arquitetura

```
┌── processo Bun (main) ──────────┐        ┌── webview (React) ──┐
│ handlers de RPC:                │  RPC   │ api.ts chama        │
│  analyzeVideo → hash            │◄──────►│  api.analyzeVideo() │
│  searchSubtitles → OpenSubtitles│ tipado │  api.searchSubs()   │
│  downloadSubtitle → salva .srt  │        │  ...                │
│  selectVideos → diálogo nativo  │        └─────────────────────┘
└─────────────────────────────────┘
```

O Electrobun cuida da janela nativa e do transporte RPC; nossa UI só chama
`api.*`, que são funções tipadas rodando no Bun com acesso a disco e rede.

## Dois modos de legenda

- **OpenSubtitles** (padrão): busca por *hash* do vídeo (sincronia exata) e baixa o `.srt`.
- **Modo AI** (tradução local): para vídeos com legenda **já embutida** (ex.: MKV),
  o app detecta as faixas, extrai a legenda (100% sincronizada) e a traduz para o
  idioma escolhido usando um LLM **local via [Ollama](https://ollama.com)** —
  preservando os timestamps. Sem custo, sem enviar nada para a nuvem.

## Pré-requisitos

1. [Bun](https://bun.sh) instalado.
2. Uma **chave de API gratuita** do OpenSubtitles (para o modo OpenSubtitles):
   - Conta em https://www.opensubtitles.com → **Consumers** → gere uma API Key
   - Cole em **⚙️ Configurações**; há um botão **Validar** e um link para a página.
3. **ffmpeg** instalado (para detectar/extrair legendas embutidas): `brew install ffmpeg`.
4. **Ollama** + um modelo (para o Modo AI): instale de https://ollama.com e rode
   `ollama pull llama3.1` (ou `gemma2:2b` para algo mais leve). Selecione o modelo
   nas Configurações.
5. **Linux** (apenas): `webkit2gtk` instalado (macOS e Windows já têm webview nativo).

## Desenvolvimento

```bash
bun install
bun run dev          # build de dev + abre o app
bun run dev:watch    # idem, com hot-reload
bun run typecheck
```

## Gerar distribuição

```bash
bun run build:stable   # gera artifacts/ com .dmg / instalador / pacote + update
```

Rode em cada SO para gerar o binário daquele sistema. Saída em `artifacts/`
(no macOS: `.dmg`, `.app.tar.zst` e `update.json`).

> **Auto-update & assinatura:** o Electrobun tem update por patch (bsdiff) e
> guias de code signing/notarização. Para ativar updates, configure
> `release.baseUrl` no `electrobun.config.ts`. Para assinar, preencha
> `build.mac.codesign/notarize` (e o certificado no Windows).

## Releases automáticos (CI)

[`.github/workflows/build.yml`](.github/workflows/build.yml) compila em cada SO
nativo (macOS arm64/Intel, Windows, Linux) via Bun + Electrobun. Ao dar push de
uma tag `v*`, publica um GitHub Release com todos os artefatos:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

## Como usar

1. Abra o app e configure a API Key, o idioma e (opcional) o modelo do Ollama.
2. Clique em **Selecionar vídeos** (diálogo nativo do Electrobun). Ao selecionar,
   as **legendas já embutidas** no arquivo são detectadas e listadas.
3. Modo OpenSubtitles: **Buscar no OpenSubtitles** → resultados com selo `sync`
   casaram pelo hash → **Baixar** (salva como `nome.<idioma>.srt`).
4. Modo AI (numa faixa embutida):
   - **Extrair .srt** → salva a legenda embutida sincronizada.
   - **Traduzir → \<idioma\> (IA)** → extrai e traduz via Ollama, com barra de
     progresso, salvando `nome.<idioma>.ai.srt` com os mesmos timestamps.

## Estrutura

```
src/
├── bun/                    # processo principal (Bun)
│   ├── index.ts               # handlers de RPC + BrowserWindow
│   └── lib/
│       ├── opensubtitles.ts   # hash (Bun.file.slice), busca, download, validate
│       ├── ffmpeg.ts          # detecta/extrai legendas embutidas (ffprobe/ffmpeg)
│       ├── ollama.ts          # cliente do Ollama (Modo AI)
│       ├── translate.ts       # extrai + traduz preservando timestamps
│       ├── srt.ts             # parse/serialize de SRT
│       ├── settings.ts        # persistência (Bun.file / Bun.write)
│       └── paths.ts           # helpers de caminho
├── mainview/               # UI (React, bundlada pelo Electrobun)
│   ├── index.html  index.css  index.tsx
│   ├── App.tsx                # componentes
│   └── api.ts                 # cliente RPC (Electroview)
└── shared/
    ├── types.ts               # tipos de domínio
    └── rpc.ts                 # contrato de RPC tipado (LegendaRPC)
electrobun.config.ts        # config de app + build
```

## Configurações

JSON por SO:
- macOS: `~/Library/Application Support/LegendaAIpraMim/settings.json`
- Windows: `%APPDATA%\LegendaAIpraMim\settings.json`
- Linux: `~/.config/legenda-ai-pra-mim/settings.json`
