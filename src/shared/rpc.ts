import type { RPCSchema } from 'electrobun/view'
import type {
  AiTranslateArgs,
  AppSettings,
  CastDevice,
  CastPlaybackStatus,
  CastStartArgs,
  DependencyStatus,
  DownloadArgs,
  DownloadResult,
  ExternalSubtitle,
  ExtractArgs,
  LogEntry,
  OllamaStatus,
  SearchArgs,
  SubtitleResult,
  TranslateProgress,
  TranslateResult,
  TranslationStatus,
  ValidateResult,
  VideoInfo
} from './types'

// Contrato de RPC tipado entre o processo Bun (main) e a webview (React).
// Lado "bun": funções que a UI chama. Lado "webview": funções que o main
// poderia chamar na UI (não usamos, mas o schema exige a forma).
export type LegendaRPC = {
  bun: RPCSchema<{
    requests: {
      selectVideos: { params: Record<string, never>; response: string[] }
      selectFolder: { params: Record<string, never>; response: string[] }
      analyzeVideo: { params: { path: string }; response: VideoInfo }
      searchSubtitles: { params: SearchArgs; response: SubtitleResult[] }
      downloadSubtitle: { params: DownloadArgs; response: DownloadResult }
      getSettings: { params: Record<string, never>; response: AppSettings }
      saveSettings: { params: AppSettings; response: AppSettings }
      exportSettings: { params: Record<string, never>; response: DownloadResult }
      importSettings: { params: Record<string, never>; response: AppSettings }
      validateApiKey: { params: { apiKey: string }; response: ValidateResult }
      extractEmbedded: { params: ExtractArgs; response: DownloadResult }
      listExternalSubtitles: { params: { path: string }; response: ExternalSubtitle[] }
      openExternal: { params: { url: string }; response: boolean }
      readClipboard: { params: Record<string, never>; response: string }
      listAiModels: { params: Record<string, never>; response: OllamaStatus }
      validateAzure: { params: Record<string, never>; response: ValidateResult }
      aiTranslateEmbedded: { params: AiTranslateArgs; response: TranslateResult }
      translationStatus: { params: AiTranslateArgs; response: TranslationStatus }
      cancelTranslate: { params: { path: string }; response: boolean }
      checkDependencies: { params: Record<string, never>; response: DependencyStatus[] }
      getLogBuffer: { params: Record<string, never>; response: LogEntry[] }
      castDiscover: { params: Record<string, never>; response: CastDevice[] }
      castStart: { params: CastStartArgs; response: boolean }
      castControl: { params: { action: 'play' | 'pause' | 'stop' | 'seek'; seconds?: number }; response: boolean }
    }
  }>
  webview: RPCSchema<{
    requests: Record<string, never>
    messages: {
      // Progresso da tradução, enviado do Bun para a UI.
      translateProgress: TranslateProgress
      // Cada linha de log do backend, em tempo real.
      log: LogEntry
      // Estado de reprodução na TV (Chromecast).
      castStatus: CastPlaybackStatus
    }
  }>
}
