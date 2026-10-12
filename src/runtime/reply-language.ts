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

const LANGUAGE_REQUEST = /\b(languages?|idiomas?|langues?|l[ií]nguas?|sprachen?|english|ingl[eé]s|anglais|englisch|spanish|espa[nñ]ol|castellano|espagnol|spanisch|french|franc[eé]s|fran[cç]ais|franz[oö]sisch|portuguese|portugu[eê]s|german|alem[aã]n|deutsch|allemand|italian|italiano|italien)\b/i

/**
 * True when the message names a language. A tool that saves a reply-language
 * preference requires it, using its `context.userMessage`, so the model cannot
 * save a language the sender never asked for.
 */
export function asksForLanguage(message: string | undefined): boolean {
  return typeof message === 'string' && LANGUAGE_REQUEST.test(message)
}
