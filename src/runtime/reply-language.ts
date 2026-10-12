/**
 * The language a Router turn replies in, for every agent app: the sender's current
 * message decides, then the conversation's. It names no language on purpose. On
 * 2026-10-12 a hospitality turn whose context said "saved language for notices is
 * Spanish" answered 10 of 19 English questions in Spanish; a model follows any
 * language the prompt names. Saved preferences belong to messages the app starts.
 */
export function replyLanguageInstruction(): string {
  return 'Reply in the language of the sender\'s current message, or in the language they ask for in it. ' +
    'When its language is unclear (a short acknowledgement, a photo, a voice note), continue in the conversation\'s language. ' +
    'Change a saved language only when the sender asks for it in this message; a message written in another language is not that request.'
}

// ISO 639-1. Names come from Intl, in English, Spanish and the language's own name,
// so a request for any language is recognised without a hand-kept list.
const LANGUAGE_CODES = ('aa ab af ak am an ar as av ay az ba be bg bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es ' +
  'et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ' +
  'ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu ' +
  'rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo ' +
  'xh yi yo za zh zu').split(' ')
// Always recognised, whatever the runtime's Intl data: generic words and the common
// languages in English, Spanish and their own names (plus हिंदी beside हिन्दी).
const CORE_NAMES = [
  'language', 'languages', 'idioma', 'idiomas', 'langue', 'lingua', 'língua', 'sprache',
  'english', 'inglés', 'ingles', 'spanish', 'español', 'espanol', 'castellano', 'french', 'français', 'francés',
  'portuguese', 'português', 'portugués', 'german', 'deutsch', 'alemán', 'italian', 'italiano', 'japanese', '日本語',
  'japonés', 'chinese', '中文', '汉语', 'chino', 'korean', '한국어', 'coreano', 'arabic', 'العربية', 'árabe', 'hindi',
  'हिन्दी', 'हिंदी', 'russian', 'русский', 'ruso', 'dutch', 'nederlands', 'neerlandés', 'hebrew', 'עברית', 'hebreo',
  'turkish', 'türkçe', 'turco', 'vietnamese', 'tiếng việt', 'vietnamita', 'catalan', 'català', 'catalán',
]
// Language names that are everyday words: "ya he ido", "él cree", "que me venda",
// "odia", "from afar", "ewe", "Latin America", "shoe polish".
const COMMON_WORDS = new Set(['ido', 'cree', 'venda', 'odia', 'afar', 'ewe', 'latin', 'polish'])

let patterns: RegExp[] | undefined
function languagePatterns(): RegExp[] {
  if (patterns) return patterns
  const names = new Set(CORE_NAMES)
  for (const locale of ['en', 'es', ...LANGUAGE_CODES]) {
    let display: Intl.DisplayNames
    // A runtime without Intl language data still has CORE_NAMES.
    try { display = new Intl.DisplayNames([locale], { type: 'language' }) } catch { continue }
    for (const code of locale === 'en' || locale === 'es' ? LANGUAGE_CODES : [locale]) {
      const name = display.of(code)?.toLowerCase()
      if (name && name !== code && name.length >= 3 && !COMMON_WORDS.has(name)) names.add(name)
    }
  }
  // Latin-script names need word edges ("pedido" must not match Ido); scripts written
  // without spaces, such as 日本語, match anywhere.
  return patterns = [...names].map(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return /^[\p{Script=Latin}\s'-]+$/u.test(name) ? new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, 'iu') : new RegExp(escaped, 'iu')
  })
}

/**
 * True when the message names a language. A tool that saves a reply-language
 * preference requires it, using its `context.userMessage`, so the model cannot
 * save a language the sender never asked for.
 */
export function asksForLanguage(message: string | undefined): boolean {
  return typeof message === 'string' && languagePatterns().some(pattern => pattern.test(message))
}
