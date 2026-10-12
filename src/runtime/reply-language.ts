/**
 * The language a Router turn replies in, for every agent app. The sender's current
 * message decides; a saved preference covers only messages whose language is
 * unclear and messages the agent starts. On 2026-10-11 a hospitality turn named the
 * member's saved language in its context, and the model answered 10 of 19 English
 * questions in Spanish. One Spanish question had also saved that language unasked.
 */
export function replyLanguageInstruction(options: { saved?: string; fallback?: string } = {}): string {
  return [
    'Reply in the language of the sender\'s current message, or in the language they ask for in it.',
    options.saved ? `Their saved language, ${options.saved}, applies only when the current message's language is unclear (a short acknowledgement, a photo, a voice note) and to messages you start.` : '',
    options.fallback ? `When nothing else decides, use ${options.fallback}.` : '',
    'Change a saved language only when the sender asks for it in this message; a message written in another language is not that request.',
  ].filter(Boolean).join(' ')
}

const LANGUAGE_REQUEST = /\b(languages?|idiomas?|langues?|l[ií]nguas?|sprachen?|english|ingl[eé]s|anglais|englisch|spanish|espa[nñ]ol|castellano|espagnol|spanisch|french|franc[eé]s|fran[cç]ais|franz[oö]sisch|portuguese|portugu[eê]s|german|alem[aã]n|deutsch|allemand|italian|italiano|italien)\b/i

/**
 * True when the message names a language. A tool that saves a reply-language
 * preference requires it, using its `context.userMessage`, so the model cannot
 * save a language the sender never asked for.
 */
export function asksForLanguage(message: string | undefined): boolean {
  return typeof message === 'string' && LANGUAGE_REQUEST.test(message)
}
