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

/**
 * Locate the line containing `value` and return it as a span — the citation
 * form for a model that cannot count characters.
 *
 * Measured on production (tax session 135b7cc3, gpt-4.1-mini): given the
 * document text and told exactly which line to cite, the model produced
 * offsets that landed on the WRONG line four times out of four, then missed
 * again on a second attempt after being shown the text its offsets had
 * selected. Character arithmetic is not something this model class does.
 *
 * What it DOES do reliably is read the value: all four `claim` fields in that
 * same run were correct to the cent. So the model names the value it read and
 * the PLATFORM finds it. Both failure modes close at once —
 *
 *  - the quote cannot be invented, because the platform slices it;
 *  - the span cannot be mis-addressed, because the platform computed it from
 *    a needle it PROVED occurs in the text.
 *
 * A needle that is not in the document is refused, which is the same fail-loud
 * posture as a quote that does not occur — and correctly so: the model is
 * asserting the document says something it does not.
 *
 * The cited span is the whole LINE, not the needle: "128,450.00" alone is not
 * a click target a reviewer can judge, whereas the line it sits on says what
 * the number IS. Number-only needles are common and deliberately supported.
 */
export type SourceFindFailure =
  | { reason: 'blank_needle' }
  | { reason: 'not_found' }
  | { reason: 'occurrence_out_of_range'; found: number }
  | { reason: 'not_distinctive'; needle: string; found: number }

/** A needle must be long enough to identify a place in the document. Two
 *  characters is not a citation: measured on production work product
 *  b9a37e44, nine evidence entries for lines the 1099-DIV does not state were
 *  cited with the value "0", and the platform faithfully matched the "0"
 *  inside "Tax Year 2025" in the header. Every one re-sliced byte-exactly and
 *  every one was worthless as evidence. */
const MIN_NEEDLE_LENGTH = 3

/** Above this many hits the needle names no particular place, so citing the
 *  first is arbitrary rather than evidential. `findOccurrence` remains the way
 *  to cite a genuinely repeated value on purpose. */
const MAX_AMBIGUOUS_MATCHES = 8

export type SourceFindResult =
  | { ok: true; span: { start: number; end: number }; quote: string; occurrences: number }
  | { ok: false; failure: SourceFindFailure }

/** Line bounds containing `index`, trimmed of the newline terminators. */
function lineAround(text: string, index: number): { start: number; end: number } {
  let start = text.lastIndexOf('\n', index)
  start = start < 0 ? 0 : start + 1
  let end = text.indexOf('\n', index)
  if (end < 0) end = text.length
  // A CRLF document leaves a trailing \r inside the line; drop it so the
  // quote is the line a reader sees rather than the line plus a control char.
  if (end > start && text[end - 1] === '\r') end -= 1
  return { start, end }
}

export function findSourceLine(
  sourceText: string,
  needle: string,
  occurrence = 1,
): SourceFindResult {
  const trimmed = needle.trim()
  if (trimmed.length === 0) return { ok: false, failure: { reason: 'blank_needle' } }
  if (trimmed.length < MIN_NEEDLE_LENGTH) {
    return { ok: false, failure: { reason: 'not_distinctive', needle: trimmed, found: 0 } }
  }

  // Exact hits first (free, and the common case). Fall back to the normalized
  // text ONLY to locate a position — the returned quote is always sliced from
  // the ORIGINAL string, so representation folding never leaks into a stored
  // citation.
  const positions: number[] = []
  for (let at = sourceText.indexOf(trimmed); at >= 0; at = sourceText.indexOf(trimmed, at + 1)) {
    positions.push(at)
  }
  if (positions.length === 0) {
    // Second chance for a needle that differs only in representation: a model
    // reading "128,450.00" off a PDF layer may report "128450.00". Scan lines
    // and compare normalized forms — cheap, and it keeps the honest-but-
    // differently-typed citation working without loosening the exact path.
    const wanted = normalizeQuoteText(trimmed)
    if (wanted.length > 0) {
      let cursor = 0
      while (cursor <= sourceText.length) {
        const bound = lineAround(sourceText, cursor)
        const line = sourceText.slice(bound.start, bound.end)
        if (normalizeQuoteText(line).includes(wanted) || normalizeQuoteText(line.replace(/,/gu, '')).includes(wanted)) {
          positions.push(bound.start)
        }
        if (bound.end >= sourceText.length) break
        cursor = bound.end + 1
      }
    }
  }
  if (positions.length === 0) return { ok: false, failure: { reason: 'not_found' } }
  // An explicit `findOccurrence` is the caller saying "yes, it repeats, I mean
  // that one" — so ambiguity is only a failure when they did NOT say which.
  if (occurrence === 1 && positions.length > MAX_AMBIGUOUS_MATCHES) {
    return { ok: false, failure: { reason: 'not_distinctive', needle: trimmed, found: positions.length } }
  }
  if (occurrence < 1 || occurrence > positions.length) {
    return { ok: false, failure: { reason: 'occurrence_out_of_range', found: positions.length } }
  }

  const bound = lineAround(sourceText, positions[occurrence - 1]!)
  const quote = sourceText.slice(bound.start, bound.end)
  if (quote.trim().length === 0) return { ok: false, failure: { reason: 'not_found' } }
  return { ok: true, span: bound, quote, occurrences: positions.length }
}

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
