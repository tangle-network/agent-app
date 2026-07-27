/**
 * Verbatim quote verification — the lineage gate.
 *
 * An evidence `locator.quote` is the reviewer's click target: it must land on
 * text that is actually in the document the entry names. Nothing here is
 * fuzzy. The only latitude is representational — the same characters written
 * differently by a PDF extractor, a text transcription, or a model repeating
 * what it read: Unicode compatibility forms, curly quotes, the several dash
 * codepoints, non-breaking spaces, and run-length whitespace. A quote that
 * still does not occur after that is not a formatting difference; it is text
 * the document does not contain.
 *
 * Deliberately NOT tolerated, because each one re-opens the hole this closes:
 * case (a quote is a quote), token subsets, edit distance, word-overlap
 * scoring, and "the numbers match" heuristics. A fabricated quote and a real
 * one differ by exactly the thing a fuzzy matcher forgives.
 */

/** Whitespace folded to a single ASCII space: the Unicode space separators
 *  (`\p{Zs}`), the line/paragraph separators, and the zero-width characters a
 *  PDF text layer leaves behind (ZWSP / ZWNJ / ZWJ / BOM). */
const WHITESPACE = /[\s\p{Zs}\u2028\u2029\u200b-\u200d\ufeff]+/gu

/** Dash-like codepoints that render alike but differ by byte: non-breaking
 *  hyphen, figure / en / em / horizontal dash, minus sign, small and fullwidth
 *  forms. */
const DASHES = /[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/gu

/** Curly, prime and grave apostrophes folded to ASCII `'`. */
const SINGLE_QUOTES = /[\u2018\u2019\u201a\u201b\u2032\u2035\u00b4`]/gu

/** Curly, low, prime and guillemet double quotes folded to ASCII `"`. */
const DOUBLE_QUOTES = /[\u201c\u201d\u201e\u201f\u2033\u2036\u00ab\u00bb]/gu

/**
 * Fold a string to the form both sides of a quote comparison are measured in.
 * Composition and presentation only: NFKC, one dash, one apostrophe, one
 * double quote, runs of any whitespace to a single space, trimmed. Case is
 * PRESERVED — lowercasing would let "Box 1" match "box 1", and a citation
 * that cannot reproduce capitalization did not read the document.
 */
export function normalizeQuoteText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(DASHES, '-')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(WHITESPACE, ' ')
    .trim()
}

/**
 * Does `quote` occur in `sourceText`? Exact substring first (the common case,
 * and free); the normalized comparison second, for the representational
 * differences above. Nothing else.
 *
 * An empty or whitespace-only quote is NOT a match — it would otherwise be a
 * substring of every document and pass the gate vacuously.
 */
export function sourceContainsQuote(sourceText: string, quote: string): boolean {
  const trimmed = quote.trim()
  if (trimmed.length === 0) return false
  if (sourceText.includes(trimmed)) return true
  const normalizedQuote = normalizeQuoteText(quote)
  if (normalizedQuote.length === 0) return false
  return normalizeQuoteText(sourceText).includes(normalizedQuote)
}
