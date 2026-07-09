import type { ElectrobunConfig } from 'electrobun'

export default {
  app: {
    name: 'Legenda AI pra mim',
    identifier: 'com.legendaaipramim.app',
    version: '1.0.0'
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
  scripts: {
    // Compila e embute o helper de OCR do macOS (Vision) no app bundle.
    postBuild: 'scripts/bundle-vision.ts'
  }
} satisfies ElectrobunConfig
