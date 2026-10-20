import { ToolInputError } from '../tools/errors'
import type { AppToolContext } from '../tools/types'
import {
  artifactAgreementErrorDetail,
  claimSupportErrorDetail,
  targetLabelErrorDetail,
  verifyArtifactAgreement,
  verifyClaimSupport,
  verifyTargetLabel,
  type ConfusableTargetGroup,
} from './claim-support'
import { findSourceLine, sliceSourceSpan, sourceContainsQuote, type SourceFindFailure, type SourceSpanFailure } from './quote'
import type { WorkProductToolConfig } from './tool-config'
import type { EvidenceEntry } from './types'

/** Turn a span rejection into the sentence the model can act on WITHOUT
 *  re-reading the document — every message names the number that was wrong and
 *  the number it must be under. */
function spanErrorDetail(failure: SourceSpanFailure): string {
  switch (failure.reason) {
    case 'not_integer':
      return `${failure.field} must be a whole character offset.`
    case 'negative':
      return `${failure.field} must not be negative.`
    case 'inverted':
      return 'end must be greater than start — the range is half-open [start, end).'
    case 'out_of_range':
      return `end is past the end of the document, which is ${failure.totalChars} characters. Offsets are absolute in the whole document: when you read with an offset, add that offset to the position within the returned text.`
    case 'blank':
      return 'that range is only whitespace. Widen it to the characters that carry the value.'
  }
}

/** Turn a locate failure into a sentence naming what was searched for. */
function findErrorDetail(failure: SourceFindFailure, needle: string): string {
  switch (failure.reason) {
    case 'blank_needle':
      return 'the value to locate is empty.'
    case 'not_found':
      return `${JSON.stringify(needle)} does not occur in that document. Read it again and cite a value it actually contains, or — if this figure is COMPUTED rather than read — omit the locator and state the computation in claim.`
    case 'occurrence_out_of_range':
      return `that value occurs ${failure.found} time(s) in the document; findOccurrence is out of range.`
    case 'not_distinctive':
      return failure.found === 0
        ? `${JSON.stringify(failure.needle)} is too short to identify a place in the document — a digit or two matches somewhere in almost any text. Cite the labelled line instead (for example "Box 1   Wages, tips, other compensation ......... 128,450.00"). If the document does not state this value at all, omit the locator and say so in claim rather than pointing at an unrelated line.`
        : `${JSON.stringify(failure.needle)} occurs ${failure.found} times, so it names no particular place. Cite a longer stretch of the supporting line, or pass findOccurrence to say which one you mean.`
  }
}

/**
 * Resolve every entry's quote against the document it names — the one place
 * lineage text is decided.
 *
 * Two citation forms, and the asymmetry between them is the point:
 *
 *  - `locator.span` — the model names `[start, end)` into text it just read
 *    and the PLATFORM slices the quote out of the source bytes. There is no
 *    retyping step, so a fabricated quote is not rejected, it is impossible.
 *    The slice REPLACES any quote the model also sent (the document is the
 *    authority, not the model's transcription of it) and the resolved text
 *    goes back in the tool result, so the model sees what was stored.
 *  - `locator.quote` alone — the legacy free-text form, still verified
 *    character-for-character. Kept because evidence written before spans
 *    existed, and sources reached through paths that cannot offer offsets,
 *    must stay expressible; a product does not lose lineage by upgrading.
 *
 * Entries are MUTATED in place with the resolved quote and its server-set
 * `quoteBasis`, then persisted — so what a reviewer reads is what the platform
 * proved, not what the model typed.
 *
 * Source texts are read once per distinct `sourceRef` in the batch — a
 * 50-entry batch citing three documents is three reads, not fifty.
 *
 * Without `readSourceText` the product has given the shell no way to see its
 * documents: free-text quotes go unchecked (as before — inventing a weaker
 * check would report unverified lineage as verified), and a span is a LOUD
 * refusal rather than a silently dropped locator, because a span the platform
 * cannot slice is a wiring bug in the product, not a model mistake.
 */
export async function resolveEvidenceQuotes(
  config: WorkProductToolConfig,
  entries: readonly EvidenceEntry[],
  ctx: AppToolContext,
): Promise<void> {
  const readSourceText = config.readSourceText
  const texts = new Map<string, string | null>()
  const readText = async (ref: string): Promise<string | null> => {
    if (!texts.has(ref)) texts.set(ref, await readSourceText!(ref, ctx))
    return texts.get(ref) ?? null
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    // `quoteBasis` arrives unset — `parseEvidenceInput` drops a model-supplied
    // one — so this function only ever WRITES it, and only on a path that
    // established it. Every `continue` below therefore leaves the entry
    // unlabelled, which is the honest state for a quote nothing proved.
    const find = entry.locator.find
    const span = entry.locator.span
    const quote = entry.locator.quote

    if (find !== undefined) {
      if (!readSourceText) {
        throw new ToolInputError(
          'span_unsupported',
          `entries[${index}].locator.find: this deployment cannot read source text, so a value cannot be located. Record the entry without locator.find.`,
          500,
        )
      }
      const text = await readText(entry.sourceRef)
      if (text === null) {
        throw new ToolInputError(
          'unverifiable_quote',
          `entries[${index}].locator.find: "${entry.sourceRef}" has no readable text, so the value cannot be located. Record the entry without a locator and state the basis in claim.`,
        )
      }
      const located = findSourceLine(text, find, entry.locator.findOccurrence ?? 1)
      if (!located.ok) {
        throw new ToolInputError(
          'value_not_found',
          `entries[${index}].locator.find into "${entry.sourceRef}": ${findErrorDetail(located.failure, find)}`,
        )
      }
      // The platform owns BOTH halves now: it found the position and it cut
      // the text. The model contributed a value it read, which is the one
      // thing it does reliably.
      entry.locator.span = located.span
      entry.locator.quote = located.quote
      entry.locator.quoteBasis = 'span'
      continue
    }

    if (span) {
      if (!readSourceText) {
        throw new ToolInputError(
          'span_unsupported',
          `entries[${index}].locator.span: this deployment cannot read source text, so a span cannot be resolved into a quote. Record the entry without locator.span.`,
          500,
        )
      }
      const text = await readText(entry.sourceRef)
      if (text === null) {
        throw new ToolInputError(
          'unverifiable_quote',
          `entries[${index}].locator.span: "${entry.sourceRef}" has no readable text, so the span cannot be resolved. Record the entry without locator.span or locator.quote and state the basis in claim.`,
        )
      }
      const sliced = sliceSourceSpan(text, span)
      if (!sliced.ok) {
        throw new ToolInputError(
          'invalid_span',
          `entries[${index}].locator.span [${span.start}, ${span.end}) into "${entry.sourceRef}": ${spanErrorDetail(sliced.failure)}`,
        )
      }
      entry.locator.quote = sliced.quote
      entry.locator.quoteBasis = 'span'
      continue
    }

    if (quote === undefined || quote.trim().length === 0) continue
    if (!readSourceText) continue
    const text = await readText(entry.sourceRef)
    if (text === null) {
      throw new ToolInputError(
        'unverifiable_quote',
        `entries[${index}].locator.quote: "${entry.sourceRef}" has no readable text, so the quote cannot be verified. Record the entry without locator.quote and state the basis in claim.`,
      )
    }
    if (!sourceContainsQuote(text, quote)) {
      throw new ToolInputError(
        'quote_not_found',
        `entries[${index}].locator.quote: ${JSON.stringify(quote)} does not occur in "${entry.sourceRef}". Cite locator.find instead — the value as it appears in the document — and this platform locates it and writes the quote itself, so the text is right by construction. If the value is COMPUTED rather than read, omit both and state the computation in claim.`,
      )
    }
    entry.locator.quoteBasis = 'model'
  }
}

/**
 * Refuse any entry whose anchored text does not carry the figure it claims.
 *
 * This runs AFTER `resolveEvidenceQuotes`, on the text the platform decided,
 * and it is deliberately independent of how that text was anchored. `find`
 * makes a mis-addressed citation unlikely — the platform locates the line — but
 * `span` still accepts offsets a caller computed, and this is what "accepted
 * only when they independently verify" means concretely: the slice has to
 * contain the value.
 *
 * Row `7256ef49` is the case. Four span citations, every quote a real slice of
 * the right document, every one ~200 characters above the figure it claimed.
 * `resolveEvidenceQuotes` passed all four; nothing else here would have caught
 * them; a reviewer would have read four authoritative-looking citations
 * supporting nothing.
 *
 * Rejection is a `ToolInputError` so it folds back to the model mid-turn, the
 * same posture a non-occurring quote already gets, and the message names both
 * ways out — cite the value, or drop the locator because the figure was
 * computed. An unsatisfiable gate does not stop a bad submit, it selects for
 * one, so naming the second exit is load-bearing rather than politeness.
 */
export function assertClaimsSupported(
  config: WorkProductToolConfig,
  entries: readonly EvidenceEntry[],
): void {
  if (config.verifyClaimSupport === false) return
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const quote = entry.locator.quote
    if (quote === undefined) continue
    const support = verifyClaimSupport(quote, entry.claim)
    if (support.status !== 'unsupported') continue
    throw new ToolInputError(
      'claim_not_supported',
      `entries[${index}].claim ${JSON.stringify(entry.claim)} is not supported by the text it cites in "${entry.sourceRef}": ${claimSupportErrorDetail(support, quote)}`,
    )
  }
}

/**
 * Refuse any entry whose cited line belongs to a sibling target.
 *
 * The fifth degree of freedom, and the one the four gates before it pass by
 * construction: `quote_verification` proves the text is in the document,
 * `claim_support` proves the text carries the claimed figure, and neither
 * asks whether the figure belongs on THIS line. Row `95105c8a` shipped
 * `evidence_coverage 6/6`, `claim_support 19/19`, `quote_verification 19/19`
 * with `line_3a` (qualified dividends) pointing at the ordinary-dividends line
 * and `line_3b` pointing at the qualified one.
 *
 * The product supplies which targets are confusable and what their lines say;
 * the shell only compares. Refusal requires the document to positively name a
 * sibling, so silence passes — see `./claim-support` for why that asymmetry is
 * load-bearing rather than lenient.
 */
export function assertTargetsNotCrossed(config: WorkProductToolConfig, entries: readonly EvidenceEntry[]): void {
  const groups = config.confusableTargets
  if (!groups || groups.length === 0) return
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const quote = entry.locator.quote
    if (quote === undefined) continue
    const verdict = verifyTargetLabel(quote, entry.target, groups)
    if (verdict.status !== 'crossed') continue
    throw new ToolInputError(
      'target_crossed',
      `entries[${index}] is attached to ${entry.target} but ${targetLabelErrorDetail(verdict, entry.target, quote)}`,
    )
  }
}

/** Re-verify every persisted quote at submit time. The upsert gate stops new
 *  fabrication; this stops a package whose evidence was written BEFORE the
 *  gate existed (or under a since-corrected document) from reaching a
 *  reviewer. Entries with no quote are neither verified nor failures — they
 *  are lineage with no click target, counted separately so the recorded check
 *  states how much of the package is quote-backed.
 *
 *  A span-anchored entry is re-checked by RE-SLICING the current document and
 *  comparing to the stored text, not by substring search. The difference
 *  matters exactly when a source has been replaced since the citation was
 *  written: a substring search would still pass if the sentence survived
 *  anywhere in the new file, while the reviewer's click target has silently
 *  moved. Re-slicing says the offsets still select the same characters. */
export async function summarizeQuoteVerification(
  config: WorkProductToolConfig,
  evidence: readonly EvidenceEntry[],
  ctx: AppToolContext,
): Promise<{ verified: number; spanAnchored: number; withoutQuote: number; failed: string[] } | undefined> {
  const readSourceText = config.readSourceText
  if (!readSourceText) return undefined
  const texts = new Map<string, string | null>()
  let verified = 0
  let spanAnchored = 0
  let withoutQuote = 0
  const failed: string[] = []
  for (const entry of evidence) {
    const quote = entry.locator.quote
    if (quote === undefined || quote.trim().length === 0) {
      withoutQuote += 1
      continue
    }
    if (!texts.has(entry.sourceRef)) texts.set(entry.sourceRef, await readSourceText(entry.sourceRef, ctx))
    const text = texts.get(entry.sourceRef)
    if (typeof text !== 'string') {
      failed.push(entry.id)
      continue
    }
    const span = entry.locator.span
    if (span) {
      const sliced = sliceSourceSpan(text, span)
      if (sliced.ok && sliced.quote === quote) {
        verified += 1
        spanAnchored += 1
      } else failed.push(entry.id)
      continue
    }
    if (sourceContainsQuote(text, quote)) verified += 1
    else failed.push(entry.id)
  }
  return { verified, spanAnchored, withoutQuote, failed }
}

/**
 * Re-run claim support over every PERSISTED entry at submit time.
 *
 * Unlike `summarizeQuoteVerification` this needs no `readSourceText`: the
 * question is whether the stored quote carries the stored claim, and both are
 * on the row. So it runs for every product, including one that cannot read its
 * sources back — and it is the check that catches a package whose evidence was
 * written before this gate existed. Row `7256ef49` is exactly that package.
 */
export function summarizeClaimSupport(evidence: readonly EvidenceEntry[]): {
  supported: number
  checkable: number
  unsupported: string[]
} {
  let supported = 0
  let checkable = 0
  const unsupported: string[] = []
  for (const entry of evidence) {
    const quote = entry.locator.quote
    if (quote === undefined) continue
    const support = verifyClaimSupport(quote, entry.claim)
    if (support.status === 'not_applicable') continue
    checkable += 1
    if (support.status === 'supported') supported += 1
    else unsupported.push(entry.id)
  }
  return { supported, checkable, unsupported }
}

/**
 * Re-run target correctness over every PERSISTED entry at submit time — the
 * check that catches a package whose evidence was written before this gate
 * existed. Like `summarizeClaimSupport` it reads only the row (the stored quote
 * and the stored target), so it runs for every product.
 */
export function summarizeTargetCorrectness(
  evidence: readonly EvidenceEntry[],
  groups: readonly ConfusableTargetGroup[],
  targetOf: (entry: EvidenceEntry) => string,
): { correct: number; checkable: number; crossed: { id: string; detail: string }[] } {
  let correct = 0
  let checkable = 0
  const crossed: { id: string; detail: string }[] = []
  for (const entry of evidence) {
    const quote = entry.locator.quote
    if (quote === undefined) continue
    const target = targetOf(entry)
    const verdict = verifyTargetLabel(quote, target, groups)
    if (verdict.status === 'not_applicable') continue
    checkable += 1
    if (verdict.status === 'identified') correct += 1
    else crossed.push({ id: entry.id, detail: `${entry.id} (${target} cites the ${verdict.rival} line)` })
  }
  return { correct, checkable, crossed }
}

/**
 * Run artifact agreement over every PERSISTED entry against the artifact being
 * submitted — the ONLY place it runs, and the "only" is load-bearing.
 *
 * The obvious second placement is the upsert, for the early feedback, and it
 * makes the gate unsatisfiable on the one path that needs it most. A
 * `changes_requested` row keeps the artifact the reviewer REJECTED, and an
 * agent correcting a crossed package has exactly one order available to it:
 * fix the evidence, then submit the corrected artifact, because the artifact
 * is only settable at submit. Comparing the incoming citation to that stale
 * artifact refuses precisely the correction being asked for —
 *
 *     artifact (rejected): line_3a = 2204.18, line_3b = 1955.02
 *     agent re-emits:      line_3a <- 1955.02          <- the fix
 *     stale comparison:    "1955.02 is line_3b's value" -> refused, forever
 *
 * so the package can never be repaired. Same failure mode as a coverage gate
 * demanding lineage for a computed value, removed for the same reason: an
 * unsatisfiable rule does not stop bad work, it selects for invented work.
 * Here both halves are current and either can be corrected during the turn.
 *
 * Nothing is lost by waiting. Row `95105c8a` is caught here and could only ever
 * have been caught here — its crossed evidence was written turns before there
 * was an artifact to compare it to.
 *
 * Only a real CONTRADICTION is refused: the claim asserts a figure the same
 * artifact reports on another target. A component of an aggregate is not one
 * (row `a68b1943` evidences a 189,750.00 wage line with two W-2s of 128,450.00
 * and 61,300.00, and must keep doing so).
 */
export function summarizeArtifactAgreement(
  evidence: readonly EvidenceEntry[],
  fieldValues: ReadonlyMap<string, string>,
  targetOf: (entry: EvidenceEntry) => string,
): { agreeing: number; checkable: number; contradicting: { id: string; detail: string }[] } {
  let agreeing = 0
  let checkable = 0
  const contradicting: { id: string; detail: string }[] = []
  for (const entry of evidence) {
    const target = targetOf(entry)
    const agreement = verifyArtifactAgreement(target, entry.claim, fieldValues)
    if (agreement.status === 'not_applicable') continue
    checkable += 1
    if (agreement.status === 'agrees') agreeing += 1
    else {
      // One home for the sentence: the same wording the per-entry refusal
      // would have used, so a reviewer reading the recorded check and a model
      // reading the error are told the same thing.
      contradicting.push({ id: entry.id, detail: `${entry.id}: ${artifactAgreementErrorDetail(agreement, target)}` })
    }
  }
  return { agreeing, checkable, contradicting }
}

