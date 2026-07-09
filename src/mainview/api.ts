import { Electroview } from 'electrobun/view'
import type { LegendaRPC } from '../shared/rpc'
import type {
  AiTranslateArgs,
  AppSettings,
  DownloadArgs,
  ExtractArgs,
  LogEntry,
  SearchArgs,
  TranslateProgress
} from '../shared/types'

// Assinantes do progresso de tradução (o App se inscreve para atualizar os cards).
type ProgressListener = (p: TranslateProgress) => void
const progressListeners = new Set<ProgressListener>()

export function onTranslateProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener)
  return () => progressListeners.delete(listener)
}

// Assinantes do log do backend (a coluna de Log se inscreve).
type LogListener = (e: LogEntry) => void
const logListeners = new Set<LogListener>()

export function onLog(listener: LogListener): () => void {
  logListeners.add(listener)
  return () => logListeners.delete(listener)
}

// Conecta o RPC tipado com o processo Bun e recebe as mensagens de progresso e log.
// maxRequestTime alto: operações como abrir o diálogo (o usuário demora a
// escolher) e a tradução por IA levam mais que o timeout padrão (~1s).
const rpc = Electroview.defineRPC<LegendaRPC>({
  maxRequestTime: 3_600_000,
  handlers: {
    requests: {},
    messages: {
      translateProgress: (progress) => {
        for (const listener of progressListeners) listener(progress)
      },
      log: (entry) => {
        for (const listener of logListeners) listener(entry)
      }
    }
  }
})
const electroview = new Electroview({ rpc })
const call = electroview.rpc!.request

export const api = {
  selectVideos: () => call.selectVideos({}),
  selectFolder: () => call.selectFolder({}),
  analyzeVideo: (path: string) => call.analyzeVideo({ path }),
  searchSubtitles: (args: SearchArgs) => call.searchSubtitles(args),
  downloadSubtitle: (args: DownloadArgs) => call.downloadSubtitle(args),
  getSettings: () => call.getSettings({}),
  saveSettings: (settings: AppSettings) => call.saveSettings(settings),
  exportSettings: () => call.exportSettings({}),
  importSettings: () => call.importSettings({}),
  validateApiKey: (apiKey: string) => call.validateApiKey({ apiKey }),
  extractEmbedded: (args: ExtractArgs) => call.extractEmbedded(args),
  listExternalSubtitles: (path: string) => call.listExternalSubtitles({ path }),
  openExternal: (url: string) => call.openExternal({ url }),
  readClipboard: () => call.readClipboard({}),
  listAiModels: () => call.listAiModels({}),
  validateAzure: () => call.validateAzure({}),
  aiTranslateEmbedded: (args: AiTranslateArgs) => call.aiTranslateEmbedded(args),
  translationStatus: (args: AiTranslateArgs) => call.translationStatus(args),
  cancelTranslate: (path: string) => call.cancelTranslate({ path }),
  checkDependencies: () => call.checkDependencies({}),
  getLogBuffer: () => call.getLogBuffer({})
}
