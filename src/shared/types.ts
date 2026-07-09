// Tipos compartilhados entre o backend (Bun) e o frontend (React no webview).

export interface EmbeddedSubtitle {
  /** Índice absoluto da faixa no arquivo (usado pelo ffmpeg em -map 0:index). */
  index: number
  /** Idioma da faixa (ex.: "por", "eng", "und"). */
  language: string
  /** Título/nome da faixa, se houver. */
  title: string
  /** Codec da legenda (ex.: "subrip", "ass", "mov_text"). */
  codec: string
  /** true se for legenda de texto (extraível/traduzível); false = imagem (PGS/VobSub → requer OCR). */
  isText: boolean
  /** true se marcada como faixa padrão. */
  isDefault: boolean
  /** true se marcada como "forced" (legendas só de trechos estrangeiros). */
  isForced: boolean
}

/** Legenda .srt externa (arquivo ao lado do vídeo, mesmo nome-base). */
export interface ExternalSubtitle {
  /** Caminho absoluto do arquivo .srt. */
  path: string
  /** Nome do arquivo (com extensão). */
  name: string
  /** Tamanho em bytes. */
  size: number
  /** Token de idioma extraído do nome (ex.: "en", "pt-br", "eng") ou '' se não houver. */
  language: string
  /** true se for uma tradução gerada por este app (arquivo ".<lang>.ai.srt"). */
  aiTranslated: boolean
}

export interface VideoInfo {
  /** Caminho absoluto do arquivo de vídeo no disco. */
  path: string
  /** Nome do arquivo (com extensão). */
  name: string
  /** Tamanho em bytes. */
  size: number
  /** Hash do OpenSubtitles (16 hex chars) usado para match exato de sincronia. */
  hash: string
  /** Faixas de legenda já embutidas no arquivo (via ffprobe). */
  embedded: EmbeddedSubtitle[]
  /** Legendas .srt externas encontradas ao lado do vídeo (mesmo nome-base). */
  external: ExternalSubtitle[]
  /** true se o ffmpeg/ffprobe foi encontrado na máquina. */
  ffmpegAvailable: boolean
  /** true se há OCR disponível (Vision no macOS, ou Tesseract) para legendas em imagem. */
  ocrAvailable: boolean
}

export interface SubtitleResult {
  /** file_id usado para efetivar o download na API. */
  fileId: number
  /** Nome do arquivo de legenda no OpenSubtitles. */
  fileName: string
  /** Código de idioma (ex.: "pt-br", "en"). */
  language: string
  /** Nome do release/rip ao qual a legenda pertence. */
  release: string
  /** Quantas vezes foi baixada (proxy de qualidade/popularidade). */
  downloadCount: number
  /** Nome do filme/episódio detectado. */
  movieName: string
  /** Nota média (0–10) atribuída pela comunidade. */
  ratings: number
  /** true quando a legenda casou pelo hash do vídeo (sincronia garantida). */
  fromHashMatch: boolean
}

export type TranslationProvider = 'ollama' | 'azure' | 'apple'

export interface AppSettings {
  /** Chave da API do OpenSubtitles (https://www.opensubtitles.com/consumers). */
  apiKey: string
  /** Idioma padrão/alvo das legendas (código ISO usado pela API e pela tradução). */
  language: string
  /** Motor de tradução de legendas. */
  translationProvider: TranslationProvider
  /** URL do servidor Ollama (tradução local). */
  ollamaUrl: string
  /** Modelo do Ollama usado para traduzir. */
  ollamaModel: string
  /** Chave do Azure AI Translator. */
  azureKey: string
  /** Região do recurso Azure (ex.: "brazilsouth"). */
  azureRegion: string
  /** Endpoint do Azure Translator. */
  azureEndpoint: string
}

export interface OllamaStatus {
  available: boolean
  models: string[]
}

export interface DependencyStatus {
  /** Nome da dependência (ex.: "ffmpeg"). */
  name: string
  /** true se foi detectada automaticamente. */
  found: boolean
  /** Caminho resolvido ou dica de instalação. */
  detail: string
  /** Para que serve no app. */
  purpose: string
}

export type LogLevel = 'info' | 'warn' | 'error' | 'debug'

export interface LogEntry {
  /** Epoch ms. */
  time: number
  level: LogLevel
  message: string
}

export interface AiTranslateArgs {
  /** Caminho do vídeo. */
  path: string
  /** Índice absoluto da faixa embutida a traduzir. */
  index: number
  /** Idioma de origem da faixa (ex.: "eng"). */
  sourceLanguage: string
  /** true = faixa de texto; false = imagem (PGS) → passa por OCR antes. */
  isText: boolean
}

export interface TranslateProgress {
  /** Caminho do vídeo em tradução (para casar com o card na UI). */
  path: string
  done: number
  total: number
  /** Fase atual: OCR (reconhecimento) ou tradução. */
  phase: 'ocr' | 'translate'
}

export interface DownloadResult {
  /** Caminho absoluto onde a legenda foi salva. */
  savedPath: string
}

export interface TranslateResult {
  /** Caminho do .srt traduzido (parcial ou completo). */
  savedPath: string
  /** Quantas falas já foram traduzidas. */
  done: number
  /** Total de falas na legenda de origem. */
  total: number
}

export interface TranslationStatus {
  /** Falas já traduzidas em disco (0 se ainda não começou). */
  done: number
  /** Total de falas da fonte (0 se não há tradução iniciada). */
  total: number
}

export interface SearchArgs {
  video: VideoInfo
  language: string
}

export interface DownloadArgs {
  video: VideoInfo
  result: SubtitleResult
}

export interface ExtractArgs {
  /** Caminho do vídeo. */
  path: string
  /** Índice absoluto da faixa embutida a extrair. */
  index: number
  /** Idioma da faixa (para nomear o arquivo). */
  language: string
  /** true = legenda de texto (→ .srt); false = imagem (→ .sup bruto). */
  isText: boolean
}

export interface ValidateResult {
  valid: boolean
  message: string
}
