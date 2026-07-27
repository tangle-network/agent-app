/**
 * Claim support — does the anchored text actually say what the entry claims?
 *
 * The two gates before this one answer different questions. `sourceContainsQuote`
 * asks whether the quote is really in the document; `findSourceLine` /
 * `sliceSourceSpan` make the platform produce the quote so it cannot be typed
 * wrong. Both are about the TEXT's provenance. Neither one looks at `claim`.
 *
 * Production row `7256ef49` is what that gap costs. Four evidence entries, all
 * `quoteBasis:'span'`, every quote a genuine slice of the document it named —
 * and every one landing on the employer/payer line about 200 characters above
 * the figure:
 *
 *     claim 128450.00  ->  "tics LLC   EIN 84-2213907\nEmployee: Dana"
 *     claim 812.44     ->  "nt Savings Bank   TIN 22-5510983\nRecip"
 *     claim 2204.18    ->  "ndex Fund Trust   TIN 47-3320115\nRec"
 *     claim 1955.02    ->  "pient: Dana R. Whitfield\n------------"
 *
 * That is strictly worse than a fabricated quote. A fabricated quote fails the
 * verbatim gate; this one passes every gate, is real text from the right
 * document, and reads to a reviewer as an authoritative citation while
 * supporting nothing. `locator.find` (the platform locating a value the model
 * names) prevents the model from ADDRESSING the wrong line, and it is the right
 * primary fix. This module is the independent check underneath it: whatever
 * anchoring form produced the text, the text has to contain the figure.
 *
 * That also settles what a raw `locator.span` is worth. Hand-computed offsets
 * stay accepted, but only when they independently verify — which is exactly
 * "the slice contains the claimed value".
 *
 * ── The rule, and why it is drawn here ──────────────────────────────────────
 *
 * Strict on figures, silent on everything else. An unsatisfiable gate does not
 * stop a bad submit, it SELECTS for one — that is the measured mechanism behind
 * the 38 fabricated quotes on row `a68b1943`, where a coverage gate demanded
 * document lineage for computed values and got thirteen invented citations
 * forty seconds later. So the rule fires only where an honest citation can
 * always satisfy it:
 *
 *  - The claim IS a value (`"128450.00"`, `"$30,000"`, `"3"`) — the anchored
 *    text MUST contain that value. No latitude. This is the shape every tax
 *    figure takes and the shape row `7256ef49` failed.
 *  - The claim is prose naming figures (`"indemnity capped at $5,000,000"`) —
 *    at least one of its currency-shaped figures must occur. Not all of them:
 *    a claim may legitimately narrate a computation over several lines while
 *    anchoring to the one line under discussion, and refusing that would make
 *    an honest citation unrepresentable for the sake of a stricter-sounding
 *    rule. One is enough to keep the anchor tethered to the claim's subject.
 *  - The claim carries no figure at all (`"Married Filing Jointly"`,
 *    `"Dana R. Whitfield"`, `"2025-04-15"`) — nothing to check, and the entry
 *    passes. A filing status has no number to find, and inventing a
 *    word-overlap score here would re-open the hole the verbatim gate closes.
 *  - The entry has no anchored text at all — nothing to check. A computed
 *    value cites its computation, not a document.
 *
 * A bare year, a form number and a box number are deliberately NOT figures:
 * `2025`, `1040` and `Box 1` have no thousands separator, no cent pair and no
 * currency symbol, so prose mentioning them does not trip the rule.
 *
 * ── Matching is value-wise, never substring ─────────────────────────────────
 *
 * `text.includes(claim)` would be the obvious implementation and it is wrong in
 * the direction that matters: it passes `"450.00"` against `"128,450.00"`, so a
 * claim citing the wrong figure survives whenever its digits happen to be a tail
 * of a real one. Both sides are tokenized into numbers and compared as VALUES,
 * so `450` and `128450` are simply different.
 */

/** Currency marks stripped before a token is read as a number. */
const CURRENCY = /[$€£¥₹]/gu

/**
 * Numbers as they occur in document text. The grouped form is tried first so
 * `128,450.00` is read as one value rather than `128` followed by `450.00` —
 * the whole point of comparing values instead of substrings.
 *
 * A leading `[$€£¥₹]?\s*` is absorbed so `$ 1,200` tokenizes once, and the
 * dot-leaders typical of a form line (`Box 1 Wages ..... 128,450.00`) are not
 * digits, so they never join a token.
 */
const NUMBER_IN_TEXT = /[$€£¥₹]?\s*\d{1,3}(?:,\d{3})+(?:\.\d+)?|[$€£¥₹]?\s*\d+(?:\.\d+)?/gu

/**
 * A figure inside prose: a currency symbol, OR thousands separators, OR a cent
 * pair. Each of the three is a positive signal that the writer meant a
 * quantity rather than an identifier, which is what keeps `2025`, `1040` and
 * `Box 1` out.
 */
const FIGURE_IN_PROSE =
  /[$€£¥₹]\s*[-+]?\d[\d,]*(?:\.\d+)?|[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[-+]?\d+\.\d{2}(?!\d)/gu

/** The whole string is one value: optional currency, sign, digits with
 *  optional grouping and decimals, optional percent. Anchored, so an EIN
 *  (`84-2213907`), a date (`2025-04-15`) and a range (`10-20`) are NOT values. */
const WHOLE_VALUE = /^[$€£¥₹]?\s*[-+]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*%?$/u

/**
 * Reduce a numeric token to the form both sides are compared in: no currency,
 * no grouping, no trailing zeros in the fraction, no leading zeros.
 *
 * Sign and accounting parentheses are stripped rather than preserved, so
 * `(1,234.00)`, `-1,234.00` and `1,234.00` all reduce to `1234`. A document
 * renders the same deduction all three ways depending on the form and the
 * extractor, and the sign is a property of the TARGET LINE's semantics, not of
 * the document's typography. Comparing magnitudes keeps those honest citations
 * working, and it concedes nothing to fabrication: the digits still have to be
 * the document's digits.
 *
 * Returns `null` for anything that is not a plain number.
 */
export function canonicalizeValue(token: string): string | null {
  let text = token.trim()
  if (text.length === 0) return null
  if (/^\(.*\)$/u.test(text)) text = text.slice(1, -1).trim()
  text = text.replace(CURRENCY, '').trim()
  text = text.replace(/^[-+]\s*/u, '').trim()
  text = text.replace(/%$/u, '').trim()
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/u.test(text)) return null
  text = text.replace(/,/gu, '')
  if (text.includes('.')) text = text.replace(/0+$/u, '').replace(/\.$/u, '')
  text = text.replace(/^0+(?=\d)/u, '')
  return text.length === 0 ? null : text
}

/** Every distinct value appearing in `text`, canonicalized. */
export function valuesInText(text: string): string[] {
  const seen = new Set<string>()
  for (const match of text.matchAll(NUMBER_IN_TEXT)) {
    const canonical = canonicalizeValue(match[0])
    if (canonical !== null) seen.add(canonical)
  }
  return [...seen]
}

/**
 * The values a claim asserts, canonicalized — empty when the claim asserts no
 * figure, which is the "nothing to check" case.
 *
 * A claim that is ENTIRELY one value yields that value (strict path). Otherwise
 * only currency-shaped figures inside the prose count, so an assertion that
 * merely mentions a year or a form number yields nothing.
 */
export function claimValues(claim: string): string[] {
  const trimmed = claim.trim()
  if (WHOLE_VALUE.test(trimmed)) {
    const whole = canonicalizeValue(trimmed)
    if (whole !== null) return [whole]
  }
  const seen = new Set<string>()
  for (const match of trimmed.matchAll(FIGURE_IN_PROSE)) {
    const canonical = canonicalizeValue(match[0])
    if (canonical !== null) seen.add(canonical)
  }
  return [...seen]
}

export type ClaimSupport =
  /** No figure to check: a non-numeric claim, or no anchored text. */
  | { status: 'not_applicable' }
  | { status: 'supported'; matched: string }
  | { status: 'unsupported'; claimed: string[]; present: string[] }

/**
 * Does `quote` carry the figure `claim` asserts?
 *
 * `supported` requires ONE claimed value to occur, which is exact for the
 * single-value claim (there is only one) and deliberate latitude for prose (see
 * the rule note at the top of the file).
 */
export function verifyClaimSupport(quote: string, claim: string): ClaimSupport {
  if (quote.trim().length === 0) return { status: 'not_applicable' }
  const claimed = claimValues(claim)
  if (claimed.length === 0) return { status: 'not_applicable' }
  const present = valuesInText(quote)
  const matched = claimed.find((value) => present.includes(value))
  if (matched !== undefined) return { status: 'supported', matched }
  return { status: 'unsupported', claimed, present }
}

/** Short, quotable rendering of the anchored text for an error message. */
function excerpt(quote: string, limit = 120): string {
  const flat = quote.replace(/\s+/gu, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * The sentence a model can act on without re-reading the document: what it
 * claimed, what the line it cited actually says, what figures that line does
 * carry, and the two ways out — cite the value, or drop the locator because the
 * figure was computed. Naming both keeps the gate satisfiable, which is the
 * property that stops it manufacturing the citation it screens for.
 */
export function claimSupportErrorDetail(
  failure: Extract<ClaimSupport, { status: 'unsupported' }>,
  quote: string,
): string {
  const wanted = failure.claimed.length === 1 ? failure.claimed[0]! : `any of ${failure.claimed.join(', ')}`
  const carries =
    failure.present.length === 0
      ? 'that line carries no figure at all'
      : `the only figures on it are ${failure.present.join(', ')}`
  return `the cited text does not contain ${wanted}. It reads "${excerpt(quote)}", and ${carries}. Cite locator.find with the value exactly as it appears in the document and the platform will locate the right line for you. If this figure was COMPUTED rather than read from the document, omit the locator entirely and state the computation in claim.`
}
