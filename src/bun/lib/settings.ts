import type { AppSettings } from '../../shared/types'
import { canonicalLang } from '../../shared/lang'
import { joinPath } from './paths'

const DEFAULTS: AppSettings = {
  apiKey: '',
  language: 'pt-BR',
  uiLanguage: 'en',
  translationProvider: 'ollama',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: '',
  azureKey: '',
  azureRegion: '',
  azureEndpoint: 'https://api.cognitive.microsofttranslator.com',
  castRamGb: 0.5
}

/** Diretório de configuração por SO (sem usar módulos externos). */
function configDir(): string {
  const env = process.env
  const home = env.HOME ?? env.USERPROFILE ?? '.'
  switch (process.platform) {
    case 'darwin':
      return joinPath(home, 'Library', 'Application Support', 'LegendaAIpraMim')
    case 'win32':
      return joinPath(env.APPDATA ?? home, 'LegendaAIpraMim')
    default:
      return joinPath(env.XDG_CONFIG_HOME ?? joinPath(home, '.config'), 'legenda-ai-pra-mim')
  }
}

function settingsFile(): string {
  return joinPath(configDir(), 'settings.json')
}

/** Normaliza o que veio de disco/UI (ex.: migra `pt-br` gravado por versões
 * antigas para o canônico `pt-BR`, que é o sufixo usado nos arquivos). */
function normalize(s: AppSettings): AppSettings {
  return { ...s, language: canonicalLang(s.language) || DEFAULTS.language }
}

export async function getSettings(): Promise<AppSettings> {
  try {
    const file = Bun.file(settingsFile())
    if (!(await file.exists())) return { ...DEFAULTS }
    return normalize({ ...DEFAULTS, ...((await file.json()) as Partial<AppSettings>) })
  } catch {
    return { ...DEFAULTS }
  }
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  const merged = normalize({ ...DEFAULTS, ...settings })
  // Bun.write cria os diretórios intermediários automaticamente.
  await Bun.write(settingsFile(), JSON.stringify(merged, null, 2))
  return merged
}
