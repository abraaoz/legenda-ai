import type { ElectrobunConfig } from 'electrobun'
import { version } from './src/shared/version'

export default {
  app: {
    name: 'Legenda AI pra mim',
    identifier: 'com.legendaaipramim.app',
    version
  },
  runtime: {
    exitOnLastWindowClosed: true
  },
  build: {
    bun: {
      entrypoint: 'src/bun/index.ts'
    },
    views: {
      mainview: {
        entrypoint: 'src/mainview/index.tsx'
      }
    },
    copy: {
      'src/mainview/index.html': 'views/mainview/index.html',
      'src/mainview/index.css': 'views/mainview/index.css'
    },
    // Ícone do app (Dock + About). O Electrobun converte a .iconset em .icns
    // via iconutil no build. Master: assets/icon-1024.png (gerado por
    // scripts/make-icon.swift).
    mac: {
      icons: 'assets/icon.iconset'
    }
  },
  release: {
    // Onde os artefatos de update vivem. A URL "latest/download" do GitHub
    // sempre redireciona pro release MAIS NOVO; como nossos nomes de artefato
    // não têm versão (ex.: stable-macos-arm64-update.json), o app checa sempre
    // o update.json mais recente. (Só o canal "stable"/"canary" atualiza; "dev" não.)
    baseUrl: 'https://github.com/abraaoz/legenda-ai/releases/latest/download',
    // Patch delta (bsdiff): no build, o Electrobun baixa o tarball da versão
    // ANTERIOR do baseUrl (latest/download → o release atual) e gera um patch
    // pra ela. Quem está 1 versão atrás baixa só o patch (pequeno); mais de 1
    // versão atrás cai no download completo (fallback automático).
    generatePatch: true
  },
  scripts: {
    // Compila e embute o helper de OCR do macOS (Vision) no app bundle.
    postBuild: 'scripts/bundle-vision.ts'
  }
} satisfies ElectrobunConfig
