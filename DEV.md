# DEV — Legenda AI pra mim 🎬

Guia técnico/de build. Para o **detalhamento completo e sempre atualizado**
(gotchas, decisões, cada subsistema), veja [`CLAUDE.md`](CLAUDE.md) — é a fonte
de verdade para quem (ou qual agente) for mexer no código.

App desktop (macOS, Windows, Linux) feito com **Bun + [Electrobun](https://electrobun.dev)**
— **sem Node, sem Electron/Chromium**.

## Stack

- **Runtime: Bun** — toda a lógica roda no processo Bun (`Bun.file`, `fetch`, `Bun.write`, `Bun.spawn`, `Bun.serve`, `Bun.udpSocket`, `Bun.connect`). APIs `node:*` são proibidas.
- **Framework: Electrobun** — webview nativo do SO, RPC tipado main↔UI, bundler, assinatura/notarização e **auto-update (patches bsdiff)** embutidos.
- **UI: React 19 + TypeScript**, bundlada pelo próprio Electrobun (`Bun.build`, não Vite).
- **Externos:** `ffmpeg`/`ffprobe` (legendas embutidas + transcode do Cast), `Ollama` (tradução local).

## O que o app faz (resumo técnico)

- **Baixar legenda** (OpenSubtitles): match por *hash* do vídeo (sincronia exata), REST API v1.
- **Traduzir legenda** preservando timestamps — 3 motores plugáveis: **Ollama** (local), **Azure AI Translator** (nuvem), **Apple** (on-device macOS 15+). Traduz faixa embutida (extrai/OCR antes) ou `.srt` externa.
- **OCR** de legenda em imagem (PGS/Blu-ray): **Vision** (macOS), **Windows.Media.Ocr**, **Tesseract** (fallback).
- **Tocar na TV** (Chromecast/Google Cast): descoberta mDNS, protocolo CASTV2, servidor de mídia com legenda VTT, e **transcode HLS on-the-fly** (buffer em RAM) para vídeos que a TV não decodifica (ex.: HEVC/x265) — com seek.

## Comandos

```bash
bun install
bun run dev          # build de dev + abre o app
bun run dev:watch    # com hot-reload
bun run typecheck    # bunx tsc --noEmit
bun run build        # build de dev em build/
bun run build:stable # distribuição em artifacts/ (.dmg / instalador / pacote + update)
```

Distribuição é **por-plataforma-host** (build no próprio SO).

## Releases (CI)

[`.github/workflows/build.yml`](.github/workflows/build.yml) roda `build:stable`
em runners nativos (macOS arm64 em `macos-15`, Windows, Linux) e publica um GitHub
Release ao dar push de uma tag `v*` **ou** por dispatch manual com o input
`release_tag`. O **auto-update** e o **patch delta (bsdiff)** usam o `release.baseUrl`
(GitHub Releases `latest/download`) — exige o repositório **público** (assets de
release privados dão 404 sem auth). Para bumpar a versão, edite **só o
`package.json`** (a versão flui via `src/shared/version.ts`).

## Estrutura

```
src/
├── bun/                 # processo principal (Bun) — disco, rede, diálogos
│   ├── index.ts            # handlers RPC + BrowserWindow + menu + auto-update
│   └── lib/                # opensubtitles, ffmpeg, translate, ocr/pgs/vision/winocr,
│       └── cast/           #   apple, azure, ollama, settings, paths, cast/ (Chromecast)
├── mainview/            # UI (React, bundlada pelo Electrobun)
└── shared/              # types.ts, rpc.ts (contrato RPC tipado), version.ts
electrobun.config.ts     # app + build + release (auto-update)
```

## Configurações (runtime)

JSON por SO:
- macOS: `~/Library/Application Support/LegendaAIpraMim/settings.json`
- Windows: `%APPDATA%\LegendaAIpraMim\settings.json`
- Linux: `~/.config/legenda-ai-pra-mim/settings.json`
