/**
 * Claim support and target correctness — is this citation attached to the RIGHT
 * place, and does the text it names actually say what the entry claims?
 *
 * Three checks live here, each answering a different half of "is this evidence
 * row honest": {@link verifyClaimSupport} (claim ↔ cited text),
 * {@link verifyTargetLabel} (target ↔ cited line), and
 * {@link verifyArtifactAgreement} (claim ↔ the artifact field it decorates).
 * They share the numeric canonicalization below, which is why they share a
 * file — a second copy of "what counts as the same figure" is how two gates
 * drift into disagreeing about the same row.
 *
 * ── Check one: claim support ────────────────────────────────────────────────
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

// ── check two: target ↔ cited line ───────────────────────────────────────────

/**
 * Does the cited line belong to the target the entry attaches it to?
 *
 * `verifyClaimSupport` asks whether the anchored text carries the claimed
 * figure. It is blind, BY CONSTRUCTION, to whether that figure belongs on that
 * line. Production row `95105c8a` is what the blindness costs — two entries,
 * both anchored to a real line of the right document, both carrying the figure
 * they claim, and both attached to the wrong form line:
 *
 *     f1040.line_3b  claim 1955.02  ->  "Box 1b  Qualified dividends ..... 1,955.02"
 *     f1040.line_3a  claim 2204.18  ->  "Box 1a  Total ordinary dividends . 2,204.18"
 *
 * Form 1040 line 3a is QUALIFIED dividends and line 3b is ORDINARY, so each
 * citation points a reviewer at the other one's line. `quote_verification`,
 * `claim_support` and `evidence_coverage` were all green on that row. A
 * citation that points at the wrong line is a wrong citation even when every
 * character of it is real, and it is the failure a reviewer is least able to
 * catch by eye, because it looks exactly like a good one.
 *
 * ── Why the domain supplies LABELS and the shell supplies the COMPARISON ────
 *
 * The shell cannot know that line 3a means qualified dividends; that is tax
 * vocabulary and baking it here would violate the one rule this package is
 * built on. So the product declares which targets are CONFUSABLE with each
 * other and what each one's line looks like in a source document — a
 * {@link ConfusableTargetGroup} — and the shell does the comparing.
 *
 * ── Why a group of labels, and not a per-target expectation ─────────────────
 *
 * The obvious shape is a per-target expectation read POSITIVELY: "a citation
 * for line_3a must contain 'Qualified'". It is stricter, it is easier to
 * explain, and it is the wrong shape, because it refuses honest work. A
 * consolidated broker statement writing "Qual. div. income", a payer writing
 * "Dividends that are qualified", an OCR layer dropping a word — each one turns
 * a correct citation into a refusal. And this codebase has already measured
 * what refusing honest work does: a coverage gate that demanded document
 * lineage for computed values produced 38 fabricated quotes on row `a68b1943`,
 * because a gate a model cannot satisfy honestly is a gate it satisfies
 * dishonestly. An unsatisfiable rule does not stop bad work; it SELECTS for
 * invented work.
 *
 * So the same labels are read NEGATIVELY and COMPARATIVELY. An entry is
 * refused only when the cited line positively identifies a SIBLING target and
 * says nothing that identifies its own:
 *
 *  - the line carries one of the target's own labels  → `identified`, pass
 *  - the line carries no label from the group at all  → `not_applicable`, pass
 *  - the line carries a sibling's label and none of its own → `crossed`, refuse
 *
 * Silence therefore always passes. An unusually-labelled document costs
 * nothing, a target the product never grouped costs nothing, and the only way
 * to fail is for the document itself to say the line belongs to a different
 * target — which is not a phrasing accident, it is the crossed pair. The rule
 * is satisfiable by the honest citation in every case, and unsatisfiable only
 * by the wrong one.
 *
 * Matching is punctuation- and case-insensitive: a label is a semantic marker
 * for which LINE this is, not a quotation. (`sourceContainsQuote` stays exact —
 * different question, different tolerance.)
 */

/** One set of targets whose source lines are mistakable for each other, with
 *  the phrases that tell them apart. Every string is product vocabulary; the
 *  shell reads none of them as meaning anything. */
export interface ConfusableTargetGroup {
  /** Named in the refusal so the model is told which distinction it missed
   *  ("Form 1099-DIV boxes 1a/1b"). */
  note?: string
  /** Target → phrases that identify THAT target's line in a source document.
   *  Targets must be spelled the way evidence targets are spelled after the
   *  product's `normalizeTarget`, so one canonical name is written once. */
  labels: Record<string, readonly string[]>
}

export type TargetLabelVerdict =
  /** No group covers this target, or the line says nothing either way. */
  | { status: 'not_applicable' }
  /** The cited line carries one of this target's own labels. */
  | { status: 'identified'; label: string }
  /** The cited line identifies a DIFFERENT target in the same group. */
  | { status: 'crossed'; rival: string; rivalLabel: string; expected: readonly string[]; note?: string }

/** Fold for label matching: case- and punctuation-insensitive, whitespace
 *  collapsed. `"Box 1b  Qualified dividends ....."` and `"qualified dividend"`
 *  meet here; nothing about the numbers on the line is touched. */
function foldLabel(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export function verifyTargetLabel(
  quote: string,
  target: string,
  groups: readonly ConfusableTargetGroup[],
): TargetLabelVerdict {
  if (quote.trim().length === 0) return { status: 'not_applicable' }
  const group = groups.find((candidate) => Object.hasOwn(candidate.labels, target))
  if (!group) return { status: 'not_applicable' }
  const line = ` ${foldLabel(quote)} `

  const own = group.labels[target] ?? []
  for (const label of own) {
    const folded = foldLabel(label)
    if (folded.length > 0 && line.includes(folded)) return { status: 'identified', label }
  }
  for (const [rival, labels] of Object.entries(group.labels)) {
    if (rival === target) continue
    for (const label of labels) {
      const folded = foldLabel(label)
      if (folded.length === 0 || !line.includes(folded)) continue
      return {
        status: 'crossed',
        rival,
        rivalLabel: label,
        expected: own,
        ...(group.note === undefined ? {} : { note: group.note }),
      }
    }
  }
  return { status: 'not_applicable' }
}

/** The sentence a model can act on: which line it actually cited, which target
 *  that line belongs to, and what its own target's line looks like. */
export function targetLabelErrorDetail(
  failure: Extract<TargetLabelVerdict, { status: 'crossed' }>,
  target: string,
  quote: string,
): string {
  const ownLooks =
    failure.expected.length === 0
      ? ''
      : ` A citation for ${target} should land on the line naming ${failure.expected.map((label) => JSON.stringify(label)).join(' or ')}.`
  const note = failure.note === undefined ? '' : ` (${failure.note})`
  return `the line it cites reads "${excerpt(quote)}", which is the line for ${failure.rival} — it names ${JSON.stringify(failure.rivalLabel)}${note}.${ownLooks} Cite the line that belongs to this target, or attach this citation to ${failure.rival} instead. The figure is real; it is on the wrong line.`
}

// ── check three: claim ↔ the artifact field it decorates ─────────────────────

/**
 * Does the entry agree with the artifact it is evidence FOR?
 *
 * The two checks above compare evidence to the SOURCE. This one compares it to
 * the DELIVERABLE, and it needs no product vocabulary at all: when the artifact
 * states a value for a target and an evidence entry attached to that target
 * asserts a different one, the work product contradicts itself, and a reviewer
 * clicking that line is shown a figure the package does not report there.
 *
 * ── The rule, and the honest citation it must not refuse ────────────────────
 *
 * "Claim must equal the field" is the tempting rule and it is unsatisfiable for
 * every aggregated or derived line. Measured on production row `a68b1943`:
 * line 1a is 189,750.00 and its two evidence rows cite $128,450.00 and
 * $61,300.00 — one per W-2, which is exactly the lineage a reviewer wants.
 * Line 8 is a Schedule C net profit of 11,056.56 evidenced by gross receipts of
 * 14,750.00 and four expense lines. Refusing those would delete correct work
 * and, on this codebase's measured history, buy invented citations in its place.
 *
 * So the refusal is narrower and it is a CONTRADICTION rather than an
 * inequality: the claim asserts a figure that the artifact itself assigns to a
 * DIFFERENT target. On row `95105c8a` that is precisely the crossed pair —
 * `line_3a` is 1955.02 in the artifact and its evidence claims 2204.18, which
 * the same artifact reports on `line_3b`. There is no honest reading of that:
 * the package cannot simultaneously say the number belongs on 3b and offer it
 * as the support for 3a.
 *
 * A component that appears nowhere else in the field map (128,450.00 of a
 * 189,750.00 total) is not a contradiction and is not refused. A claim
 * narrating a computation passes as soon as one of its figures is the target's
 * own value, which is what a narration of line 9 does by definition.
 */

/** Canonical target → canonical value, for the artifact fields that state a
 *  figure. Non-numeric fields are dropped: a filing status or a name has no
 *  numeric contradiction to detect, and inventing a string comparison here
 *  would re-open the fuzzy-matching hole the quote gate closes. */
export function indexArtifactValues(
  fields: Readonly<Record<string, unknown>> | undefined,
  normalizeTarget?: (target: string) => string,
): Map<string, string> {
  const index = new Map<string, string>()
  for (const [key, raw] of Object.entries(fields ?? {})) {
    const value =
      typeof raw === 'number' && Number.isFinite(raw)
        ? canonicalizeValue(String(raw))
        : typeof raw === 'string'
          ? canonicalizeValue(raw)
          : null
    if (value === null) continue
    index.set(normalizeTarget ? normalizeTarget(key) : key, value)
  }
  return index
}

export type ArtifactAgreement =
  /** The artifact states no figure for this target, or the claim asserts none. */
  | { status: 'not_applicable' }
  | { status: 'agrees'; value: string }
  /** The claim asserts a figure the artifact reports on a different target. */
  | { status: 'contradicts'; claimed: string; expected: string; belongsTo: string }

export function verifyArtifactAgreement(
  target: string,
  claim: string,
  fieldValues: ReadonlyMap<string, string>,
): ArtifactAgreement {
  const expected = fieldValues.get(target)
  if (expected === undefined) return { status: 'not_applicable' }
  const claimed = claimValues(claim)
  if (claimed.length === 0) return { status: 'not_applicable' }
  if (claimed.includes(expected)) return { status: 'agrees', value: expected }
  for (const value of claimed) {
    for (const [other, otherValue] of fieldValues) {
      if (other === target || otherValue !== value) continue
      return { status: 'contradicts', claimed: value, expected, belongsTo: other }
    }
  }
  return { status: 'not_applicable' }
}

/** The sentence a model can act on: both numbers, both lines, and the two ways
 *  out — move the citation, or correct the artifact. */
export function artifactAgreementErrorDetail(
  failure: Extract<ArtifactAgreement, { status: 'contradicts' }>,
  target: string,
): string {
  return `the artifact reports ${failure.expected} on ${target} and ${failure.claimed} on ${failure.belongsTo}, so a citation claiming ${failure.claimed} does not support ${target} — it supports ${failure.belongsTo}. Attach this citation to ${failure.belongsTo}, or correct the artifact if ${target} really is ${failure.claimed}. The package cannot state both.`
}
