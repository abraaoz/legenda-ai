import { ApplicationMenu, BrowserView, BrowserWindow, Updater, Utils } from 'electrobun/bun'
import type { LegendaRPC } from '../shared/rpc'
import type { AppSettings, CastPlaybackStatus, LogEntry } from '../shared/types'
import { castControl, castDiscover, castStart, setCastStatusSink } from './lib/cast/manager'
import { checkDependencies } from './lib/dependencies'
import { findExternalSubtitles, listVideosInFolder } from './lib/files'
import { extractEmbedded } from './lib/ffmpeg'
import { saveFileDialog } from './lib/savedialog'
import { getLogBuffer, loge, logi, setLogSink } from './lib/logger'
import { listModels } from './lib/ollama'
import {
  analyzeVideo,
  downloadSubtitle,
  searchSubtitles,
  validateApiKey
} from './lib/opensubtitles'
import { azureValidate } from './lib/azure'
import { getSettings, saveSettings } from './lib/settings'
import {
  aiTranslateEmbedded,
  createAppleTranslator,
  createAzureTranslator,
  createOllamaTranslator,
  getTranslationStatus
} from './lib/translate'

let mainWindow: BrowserWindow | undefined

// O proxy .send existe em runtime (createRPC), mas não no tipo público exposto.
type ProgressMsg = { path: string; done: number; total: number; phase: 'ocr' | 'translate' }
type MessageSender = {
  send: {
    translateProgress: (p: ProgressMsg) => void
    log: (e: LogEntry) => void
    castStatus: (s: CastPlaybackStatus) => void
  }
}
function messenger(): MessageSender['send'] | undefined {
  return (mainWindow?.webview?.rpc as unknown as MessageSender | undefined)?.send
}
function sendProgress(p: ProgressMsg): void {
  messenger()?.translateProgress(p)
}

const VIDEO_TYPES = 'mp4,mkv,avi,mov,m4v,wmv,flv,webm,mpg,mpeg,ts'

// Traduções em andamento, para permitir cancelamento (por caminho do vídeo).
const activeTranslations = new Map<string, AbortController>()

/** Loga início/fim/erro de cada chamada RPC (backend verboso). */
function logged<A, R>(name: string, fn: (arg: A) => R | Promise<R>): (arg: A) => Promise<R> {
  return async (arg: A) => {
    const argStr = arg && typeof arg === 'object' ? JSON.stringify(arg) : ''
    logi(`▶ ${name}${argStr ? ` ${argStr}` : ''}`)
    try {
      const result = await fn(arg)
      const preview = Array.isArray(result)
        ? `${result.length} item(ns)`
        : typeof result === 'object'
          ? JSON.stringify(result).slice(0, 200)
          : String(result)
      logi(`✔ ${name} → ${preview}`)
      return result
    } catch (err) {
      loge(`✘ ${name}: ${(err as Error).message}`)
      throw err
    }
  }
}

// Handlers de RPC: a UI (webview) chama estas funções que rodam no Bun,
// com acesso total ao disco, rede e diálogos nativos.
const rpc = BrowserView.defineRPC<LegendaRPC>({
  maxRequestTime: 3_600_000, // tradução local (Modo AI) pode levar minutos
  handlers: {
    requests: {
      selectVideos: logged('selectVideos', async () => {
        const paths = await Utils.openFileDialog({
          allowedFileTypes: VIDEO_TYPES,
          canChooseFiles: true,
          canChooseDirectory: false,
          allowsMultipleSelection: true
        })
        return paths.filter((p) => p.length > 0)
      }),
      selectFolder: logged('selectFolder', async () => {
        const dirs = await Utils.openFileDialog({
          canChooseFiles: false,
          canChooseDirectory: true,
          allowsMultipleSelection: false
        })
        const dir = dirs.filter((p) => p.length > 0)[0]
        return dir ? listVideosInFolder(dir) : []
      }),
      analyzeVideo: logged('analyzeVideo', ({ path }) => analyzeVideo(path)),
      searchSubtitles: logged('searchSubtitles', async ({ video, language }) => {
        const { apiKey } = await getSettings()
        return searchSubtitles(apiKey, video, language)
      }),
      downloadSubtitle: logged('downloadSubtitle', async ({ video, result }) => {
        const { apiKey } = await getSettings()
        return downloadSubtitle(apiKey, video, result)
      }),
      getSettings: logged('getSettings', () => getSettings()),
      saveSettings: logged('saveSettings', (settings) => saveSettings(settings)),
      exportSettings: logged('exportSettings', async () => {
        const savedPath = await saveFileDialog('legenda-ai-settings.json', 'Exportar configurações')
        if (!savedPath) return { savedPath: '' }
        await Bun.write(savedPath, JSON.stringify(await getSettings(), null, 2))
        return { savedPath }
      }),
      importSettings: logged('importSettings', async () => {
        const files = await Utils.openFileDialog({
          allowedFileTypes: 'json',
          canChooseFiles: true,
          canChooseDirectory: false,
          allowsMultipleSelection: false
        })
        const file = files.filter((p) => p.length > 0)[0]
        if (!file) return getSettings()
        const parsed = JSON.parse(await Bun.file(file).text()) as Partial<AppSettings>
        return saveSettings({ ...(await getSettings()), ...parsed })
      }),
      validateApiKey: logged('validateApiKey', ({ apiKey }) => validateApiKey(apiKey)),
      extractEmbedded: logged('extractEmbedded', ({ path, index, language, isText }) =>
        extractEmbedded(path, index, language, isText)
      ),
      listExternalSubtitles: logged('listExternalSubtitles', ({ path }) =>
        findExternalSubtitles(path)
      ),
      openExternal: logged('openExternal', ({ url }) => Utils.openExternal(url)),
      readClipboard: () => Utils.clipboardReadText() ?? '',
      listAiModels: logged('listAiModels', async () => {
        const { ollamaUrl } = await getSettings()
        return listModels(ollamaUrl)
      }),
      checkDependencies: logged('checkDependencies', () => checkDependencies()),
      getLogBuffer: () => getLogBuffer(),
      castDiscover: logged('castDiscover', () => castDiscover()),
      castStart: logged('castStart', async (args) => {
        await castStart(args)
        return true
      }),
      castControl: logged('castControl', async ({ action, seconds }) => {
        await castControl(action, seconds)
        return true
      }),
      aiTranslateEmbedded: logged(
        'aiTranslateEmbedded',
        async ({ path, index, sourceLanguage, isText }) => {
          const s = await getSettings()
          const translator =
            s.translationProvider === 'apple'
              ? await createAppleTranslator(sourceLanguage, s.language)
              : s.translationProvider === 'azure'
                ? createAzureTranslator(
                    { key: s.azureKey, region: s.azureRegion, endpoint: s.azureEndpoint },
                    s.language
                  )
                : createOllamaTranslator(s.ollamaUrl, s.ollamaModel, s.language)
          logi(`Motor de tradução: ${s.translationProvider}${isText ? '' : ' (com OCR)'}`)
          const controller = new AbortController()
          activeTranslations.set(path, controller)
          try {
            return await aiTranslateEmbedded(
              { path, index, sourceLanguage, targetCode: s.language, isText },
              translator,
              (done, total) => sendProgress({ path, done, total, phase: 'translate' }),
              (done, total) => sendProgress({ path, done, total, phase: 'ocr' }),
              controller.signal
            )
          } finally {
            activeTranslations.delete(path)
          }
        }
      ),
      validateAzure: logged('validateAzure', async () => {
        const { azureKey, azureRegion, azureEndpoint } = await getSettings()
        return azureValidate({ key: azureKey, region: azureRegion, endpoint: azureEndpoint })
      }),
      translationStatus: logged('translationStatus', async ({ path, index, sourceLanguage }) => {
        const { language } = await getSettings()
        return getTranslationStatus(path, index, sourceLanguage, language)
      }),
      cancelTranslate: logged('cancelTranslate', ({ path }) => {
        const controller = activeTranslations.get(path)
        if (!controller) return false
        controller.abort()
        return true
      })
    }
  }
})

mainWindow = new BrowserWindow({
  title: 'Legenda AI pra mim',
  url: 'views://mainview/index.html',
  frame: { width: 1400, height: 820, x: 120, y: 100 },
  titleBarStyle: 'hiddenInset',
  rpc
})

// Menu nativo — sem ele, atalhos de edição (Cmd+V/C/X/A) não são roteados no macOS.
ApplicationMenu.setApplicationMenu([
  {
    label: 'Legenda AI pra mim',
    submenu: [
      { role: 'about' },
      { label: 'Buscar atualizações…', action: 'check-for-updates' },
      { type: 'separator' },
      { role: 'hide', accelerator: 'CmdOrCtrl+H' },
      { role: 'hideOthers' },
      { role: 'showAll' },
      { type: 'separator' },
      { role: 'quit', accelerator: 'CmdOrCtrl+Q' }
    ]
  },
  {
    label: 'Editar',
    submenu: [
      { role: 'undo', accelerator: 'CmdOrCtrl+Z' },
      { role: 'redo', accelerator: 'CmdOrCtrl+Shift+Z' },
      { type: 'separator' },
      { role: 'cut', accelerator: 'CmdOrCtrl+X' },
      { role: 'copy', accelerator: 'CmdOrCtrl+C' },
      { role: 'paste', accelerator: 'CmdOrCtrl+V' },
      { role: 'selectAll', accelerator: 'CmdOrCtrl+A' }
    ]
  }
])

// A partir daqui, todo log() do backend também vai para a coluna de Log na UI.
setLogSink((entry) => messenger()?.log(entry))

// Estado de reprodução na TV (Chromecast) → empurra pra UI.
setCastStatusSink((s) => messenger()?.castStatus(s))

// Auto-update (Electrobun): o menu "Buscar atualizações…" checa o release mais
// novo no GitHub (release.baseUrl), baixa e aplica reiniciando. Cada mudança de
// status vai para a coluna de Log. Em builds "dev" o Updater ignora (canal dev).
Updater.onStatusChange((entry) => logi(`[update] ${entry.status}: ${entry.message}`))

let updateChecking = false
async function checkForUpdates(): Promise<void> {
  if (updateChecking) return
  updateChecking = true
  try {
    logi('Buscando atualizações…')
    const info = await Updater.checkForUpdate()
    if (!info.updateAvailable) {
      logi(`Você já está na versão mais recente${info.version ? ` (${info.version})` : ''}.`)
      return
    }
    logi(`Atualização disponível: ${info.version}. Baixando…`)
    await Updater.downloadUpdate()
    logi('Atualização baixada — aplicando e reiniciando…')
    await Updater.applyUpdate()
  } catch (err) {
    loge(`Falha ao atualizar: ${(err as Error).message}`)
  } finally {
    updateChecking = false
  }
}

ApplicationMenu.on('application-menu-clicked', (event) => {
  const action = (event as { data?: { action?: string } })?.data?.action
  if (action === 'check-for-updates') void checkForUpdates()
})

logi('App iniciado — backend pronto.')
