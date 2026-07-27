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

// ── spans: the citation form that cannot be wrong ────────────────────────────

/**
 * Slice a citation out of the source text by character offset — the reason
 * this module exists in its stronger form.
 *
 * Verification above is a REJECTION gate: the model retypes a quote and the
 * shell refuses it when the characters do not occur. That gate is correct and
 * it works, but a model that reproduces a line character-for-character only
 * some of the time cannot USE it — every miss is a refusal, and the package
 * ends up with no lineage at all rather than false lineage. A measured 9 of 59
 * on the live tax surface is what "some of the time" meant in practice.
 *
 * A span inverts it. The model names two integers into text it just read; the
 * PLATFORM produces the quote from the bytes it already holds. There is no
 * retyping step to get wrong, so a fabricated quote is not rejected — it is
 * unrepresentable. `sourceContainsQuote(text, sliceSourceSpan(text, span))` is
 * true for every span this function returns, by construction.
 *
 * Offsets index the SAME string the product's document-reading tool pages
 * with an offset, which is the same string its `readSourceText` seam returns.
 * That is the one contract a product must keep; violate it and spans point at
 * the wrong characters (still real characters of that document — never
 * invented text, but the wrong line).
 *
 * Half-open `[start, end)`, matching `String.prototype.slice` and the
 * `offset`/`offset + text.length` window a paged read already reports.
 */
export type SourceSpanFailure =
  | { reason: 'not_integer'; field: 'start' | 'end' }
  | { reason: 'negative'; field: 'start' | 'end' }
  | { reason: 'inverted' }
  | { reason: 'out_of_range'; totalChars: number }
  | { reason: 'blank' }

export type SourceSpanResult =
  | { ok: true; quote: string }
  | { ok: false; failure: SourceSpanFailure }

/** Resolve `[start, end)` against `sourceText`. Every rejection is a caller
 *  mistake the model can correct from the paged read it already has, so each
 *  carries the discriminator a tool layer turns into a specific message. */
export function sliceSourceSpan(
  sourceText: string,
  span: { start: number; end: number },
): SourceSpanResult {
  for (const field of ['start', 'end'] as const) {
    const value = span[field]
    if (!Number.isInteger(value)) return { ok: false, failure: { reason: 'not_integer', field } }
    if (value < 0) return { ok: false, failure: { reason: 'negative', field } }
  }
  if (span.end <= span.start) return { ok: false, failure: { reason: 'inverted' } }
  if (span.end > sourceText.length) {
    return { ok: false, failure: { reason: 'out_of_range', totalChars: sourceText.length } }
  }
  const quote = sourceText.slice(span.start, span.end)
  // A whitespace-only slice is a real slice of the document and would pass
  // `sourceContainsQuote` on any text — the same vacuous pass an empty quote
  // gets there, refused for the same reason: it is not a click target.
  if (quote.trim().length === 0) return { ok: false, failure: { reason: 'blank' } }
  return { ok: true, quote }
}
