/**
 * Canoniza um código de idioma no formato BCP-47: idioma em minúsculo e região
 * em MAIÚSCULA — `pt-br` → `pt-BR`, `PT-pt` → `pt-PT`, `EN` → `en`.
 *
 * Por que importa: o código vira sufixo do nome do arquivo (`Filme.pt-BR.srt`,
 * padrão do Jellyfin). Em filesystem case-sensitive (Linux), `pt-br` e `pt-BR`
 * seriam arquivos DIFERENTES — daria legenda duplicada e o app não acharia a
 * tradução já feita. As APIs externas não se importam: OpenSubtitles, Azure,
 * Apple e Ollama já normalizam o código com `toLowerCase()` antes de usar.
 */
/** ISO 639-2 (o que vem nas faixas embutidas, via ffprobe) → 639-1, que é o
 * formato dos exemplos do Jellyfin (`.en.srt`, não `.eng.srt`). Código
 * desconhecido fica como está (minúsculo). */
const ISO3_TO_ISO1: Record<string, string> = {
  eng: 'en', por: 'pt', spa: 'es', fra: 'fr', fre: 'fr', ita: 'it',
  deu: 'de', ger: 'de', jpn: 'ja', rus: 'ru', kor: 'ko', zho: 'zh', chi: 'zh',
  nld: 'nl', dut: 'nl', swe: 'sv', dan: 'da', nor: 'no', fin: 'fi', pol: 'pl',
  tur: 'tr', ara: 'ar', heb: 'he', hin: 'hi', ces: 'cs', cze: 'cs',
  ell: 'el', gre: 'el', hun: 'hu', ron: 'ro', rum: 'ro', ukr: 'uk',
  vie: 'vi', tha: 'th', ind: 'id'
}

export function canonicalLang(code: string): string {
  const [langRaw, region] = (code || '').trim().split('-')
  if (!langRaw) return ''
  const lang = langRaw.toLowerCase()
  const iso1 = ISO3_TO_ISO1[lang] ?? lang
  return region ? `${iso1}-${region.toUpperCase()}` : iso1
}
