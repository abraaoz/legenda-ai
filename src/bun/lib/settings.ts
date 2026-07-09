import type { AppSettings } from '../../shared/types'
import { joinPath } from './paths'

const DEFAULTS: AppSettings = {
  apiKey: '',
  language: 'pt-br',
  translationProvider: 'ollama',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: '',
  azureKey: '',
  azureRegion: '',
  azureEndpoint: 'https://api.cognitive.microsofttranslator.com'
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

export async function getSettings(): Promise<AppSettings> {
  try {
    const file = Bun.file(settingsFile())
    if (!(await file.exists())) return { ...DEFAULTS }
    return { ...DEFAULTS, ...((await file.json()) as Partial<AppSettings>) }
  } catch {
    return { ...DEFAULTS }
  }
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  const merged: AppSettings = { ...DEFAULTS, ...settings }
  // Bun.write cria os diretórios intermediários automaticamente.
  await Bun.write(settingsFile(), JSON.stringify(merged, null, 2))
  return merged
}
