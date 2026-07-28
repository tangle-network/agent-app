/**
 * The agent-facing work-product side channel — three registry `customTools`
 * built on `/tools`' `defineAppTool`, dispatched through `dispatchAppTool`'s
 * single validation/outcome path (a thrown `ToolInputError` → correctable 4xx
 * back to the model; any other throw → internal error; a call never silently
 * succeeds without its effect). Deliberately NOT new `/tools` built-ins:
 * extending `AppToolHandlers` would break every existing consumer, and the
 * registry seam exists precisely for a product tool family like this.
 *
 * Partial-emission contract across a long turn: the draft ROW is the
 * accumulator. Evidence and exceptions stream in as found via small batched
 * calls; the artifact arrives once at the end. The agent addresses everything
 * by `scopeKey` — the server mints row ids, the model never invents them, and
 * identity (userId/workspaceId/threadId) rides the trusted `AppToolContext`
 * from headers, never model args. A turn that dies mid-emission leaves a
 * consistent draft the next turn resumes by the same scopeKey.
 */

import { ToolInputError } from '../tools/errors'
import { defineAppTool, type AppToolDefinition } from '../tools/registry'
import type { AppToolContext } from '../tools/types'
import { createWorkProductService, type WorkProductOutcome, type WorkProductService } from './service'
import { stampProvenance, type WorkProductProvenanceBase } from './provenance'
import { findSourceLine, sliceSourceSpan, sourceContainsQuote, type SourceFindFailure, type SourceSpanFailure } from './quote'
import {
  artifactAgreementErrorDetail,
  claimSupportErrorDetail,
  indexArtifactValues,
  targetLabelErrorDetail,
  verifyArtifactAgreement,
  verifyClaimSupport,
  verifyTargetLabel,
  type ConfusableTargetGroup,
} from './claim-support'
import {
  parseAgentCheckInput,
  parseArtifactInput,
  parseEvidenceInput,
  parseExceptionInput,
  unresolvedBlockingExceptions,
  type EvidenceEntry,
  type ExceptionEntry,
  type QualityCheck,
  type WorkProductArtifact,
  type WorkProductRecord,
  type WorkProductStorePort,
} from './types'

/** Max entries per `upsert_evidence`/`flag_exception` call — keeps each call a
 *  small batch the model can correct precisely on a named-index failure. */
export const MAX_WORK_PRODUCT_BATCH = 50

/** Platform check: every material target has ≥1 evidence row. Recorded as
 *  `QualityCheck{source:'platform'}`. */
export const EVIDENCE_COVERAGE_CHECK = 'evidence_coverage'

/** Platform check: how many evidence entries carry a quote the shell PROVED
 *  occurs in the source it names. Recorded when `readSourceText` is wired, so
 *  a reviewer reads the strength of the lineage off the row itself rather than
 *  trusting that a quote was checked. */
export const QUOTE_VERIFICATION_CHECK = 'quote_verification'

/** Platform check: how many quoted evidence entries anchor to text that
 *  actually CARRIES the figure the entry claims. Distinct from
 *  `quote_verification`, which only proves the text came from the document —
 *  production row `7256ef49` passed that one on all four entries while
 *  supporting none of them. */
export const CLAIM_SUPPORT_CHECK = 'claim_support'

/** Platform check: how many citations anchor to a line that belongs to the
 *  TARGET they are attached to, rather than to a sibling target's line.
 *  Recorded when the product declares `confusableTargets`; `claim_support`
 *  passes a crossed pair by construction, because the figure really is on the
 *  line — the wrong one. */
export const TARGET_CORRECTNESS_CHECK = 'target_correctness'

/** Platform check: how many evidence claims agree with the artifact field they
 *  decorate. A package whose evidence reports one figure on a line and whose
 *  artifact reports another contradicts itself; every other gate on this row
 *  reads only one of the two halves. */
export const ARTIFACT_AGREEMENT_CHECK = 'artifact_agreement'

/** Domain seams for the three work-product tools — every domain word is a
 *  parameter; the shell bakes none. */
export interface WorkProductToolConfig {
  store: WorkProductStorePort
  /** PARAMETER — accepted `artifact.kind` values, validated on submit. */
  artifactKinds: readonly string[]
  /** PARAMETER — accepted exception `kind` values. */
  exceptionKinds: readonly string[]
  /** Fail-loud source check: resolve an evidence `sourceRef` to existence
   *  (vault stat / attachment lookup). A dangling ref is a `ToolInputError`
   *  naming the entry index — lineage can never point at nothing. */
  resolveSourceRef: (ref: string, ctx: AppToolContext) => Promise<boolean>
  /** Fail-loud QUOTE verification: return the source document's TEXT for a
   *  ref so the shell can prove each `locator.quote` occurs in it verbatim.
   *  Wiring this turns the gate ON — a quote that does not occur is a
   *  `ToolInputError` naming the entry index, so the model re-extracts from
   *  the document instead of persisting invented lineage.
   *
   *  Return `null` ONLY when the ref genuinely has no extractable text (an
   *  image scan, an opaque blob). The gate is fail-CLOSED on `null`: a quote
   *  that cannot be checked is refused, because "unverifiable" and "verified"
   *  must never look the same to a reviewer. Such an entry is still recordable
   *  without `locator.quote` — `claim` carries the assertion.
   *
   *  Omit the seam entirely and no quote is checked. */
  readSourceText?: (ref: string, ctx: AppToolContext) => Promise<string | null>
  /** The material targets the platform coverage check requires evidence for.
   *  Product-owned vocabulary; omit to skip the coverage gate.
   *
   *  Return ONLY targets a source document can actually evidence. A gate that
   *  demands document lineage for a value the session COMPUTED is not
   *  satisfiable by any honest answer, and an unsatisfiable gate does not stop
   *  a submit — it selects for an invented one. Computed values belong to a
   *  product's own computation check, where "matches what we already
   *  calculated" is satisfiable by construction. */
  materialTargets?: (artifact: WorkProductArtifact) => string[]
  /** Require every material target to carry a SOURCE ANCHOR — a span-sliced or
   *  verified quote — not merely an evidence row. Off by default (a bare
   *  `claim` is legitimate lineage for products with no readable sources);
   *  turn it ON once `readSourceText` is wired and `materialTargets` names only
   *  document-derived targets, and coverage stops being satisfiable by
   *  assertion. */
  requireAnchoredEvidence?: boolean
  /** Verify that each anchored quote CARRIES the figure its entry claims.
   *  ON by default — an anchor that does not support its claim is the one
   *  failure mode every other gate here passes, and it reads to a reviewer as
   *  the most authoritative citation on the row.
   *
   *  Only claims that assert a figure are checked, so a filing status, a name
   *  or a date is unaffected; see `./claim-support` for exactly where the line
   *  is drawn and why it is drawn to stay satisfiable. Set `false` only for a
   *  product whose claims are figures the source states in a form no numeric
   *  comparison can reach. */
  verifyClaimSupport?: boolean
  /** Fold an evidence `target` (and every `materialTargets` name) to the
   *  product's ONE canonical spelling.
   *
   *  Without it a target namespace forks and every check that joins evidence
   *  to the artifact by name silently half-works. Measured on production row
   *  `95105c8a`: the same seven form lines arrived as `line_3a` and
   *  `f1040.line_3a` in one turn, so coverage, deduplication and artifact
   *  agreement each saw two unrelated targets where the return has one line.
   *
   *  Pure and total — it runs on every ingested entry and on the coverage
   *  target list, so a target it does not recognize must come back unchanged
   *  rather than throw. */
  normalizeTarget?: (target: string) => string
  /** Targets whose SOURCE LINES are mistakable for each other, with the
   *  phrases that tell them apart — the product's vocabulary, compared by the
   *  shell. Omit and no target-correctness check runs.
   *
   *  Read negatively: an entry is refused only when the line it cites carries
   *  a sibling target's label and none of its own, so an unusually-labelled
   *  document never costs an honest citation. See `./claim-support` for why
   *  the positive form ("the line must say X") is the wrong shape. */
  confusableTargets?: readonly ConfusableTargetGroup[]
  /** Refuse an evidence claim that asserts a figure the artifact reports on a
   *  DIFFERENT target. ON by default and domain-free — it compares the package
   *  to itself. Set `false` only for a product whose evidence claims are not
   *  the artifact's own figures. */
  verifyArtifactAgreement?: boolean
  /** Per-turn provenance closure the ROUTE supplies (profileHash + runId are
   *  known at dispatch; trusted, never read from model args). */
  provenance: (ctx: AppToolContext) => WorkProductProvenanceBase
  /** Called on the draft→ready commit so the route persists the transcript
   *  anchor part and the queue projection updates. */
  onReady?: (record: WorkProductRecord, ctx: AppToolContext) => void | Promise<void>
  /** Injectable clock / id generator (tests, deterministic ids). */
  now?: () => number
  generateId?: () => string
}

/** Unwrap a guarded outcome, retrying ONCE on a lost race (the single
 *  serialized turn owner makes real contention rare; one re-read-and-retry
 *  absorbs the benign case). A deterministic rejection maps to a correctable
 *  `ToolInputError` so the model learns exactly why. */
async function unwrap<T>(
  run: () => Promise<WorkProductOutcome<T>>,
  code: string,
): Promise<T> {
  let outcome = await run()
  if (!outcome.succeeded && outcome.conflict) outcome = await run()
  if (!outcome.succeeded) throw new ToolInputError(code, outcome.error, outcome.conflict ? 409 : 400)
  return outcome.value
}

function requireScopeKey(args: Record<string, unknown>): string {
  const scopeKey = typeof args.scopeKey === 'string' ? args.scopeKey.trim() : ''
  if (!scopeKey) throw new ToolInputError('missing_scope_key', 'scopeKey is required — the engagement key this work product belongs to.')
  return scopeKey
}

function requireBatch(args: Record<string, unknown>, field: string): unknown[] {
  const raw = args[field]
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ToolInputError('missing_entries', `${field} must be a non-empty array.`)
  }
  if (raw.length > MAX_WORK_PRODUCT_BATCH) {
    throw new ToolInputError('batch_too_large', `${field} accepts at most ${MAX_WORK_PRODUCT_BATCH} entries per call — send smaller batches.`)
  }
  return raw
}

/**
 * Resolve the scope's open draft row, creating or reopening as needed:
 * an open `draft`/`blocked` row resumes; a `changes_requested` row reopens as
 * the correction draft (version +1); a `ready` row refuses — the package is
 * awaiting review and must receive a verdict first; otherwise a fresh draft
 * is created at `last reviewed version + 1` with dispatch-stamped provenance.
 */
async function resolveDraft(
  service: WorkProductService,
  config: WorkProductToolConfig,
  scopeKey: string,
  ctx: AppToolContext,
): Promise<WorkProductRecord> {
  const open = await service.openDraft(ctx.workspaceId, scopeKey)
  if (open) return open
  const awaitingReview = await service.awaitingReview(ctx.workspaceId, scopeKey)
  if (awaitingReview) {
    throw new ToolInputError(
      'awaiting_review',
      `Work product for ${scopeKey} (v${awaitingReview.version}) is awaiting review — no further emission until a reviewer verdict.`,
      409,
    )
  }
  const awaitingCorrection = await service.awaitingCorrection(ctx.workspaceId, scopeKey)
  if (awaitingCorrection) {
    return unwrap(() => service.reopen(awaitingCorrection.id), 'reopen_failed')
  }
  return service.create({
    workspaceId: ctx.workspaceId,
    threadId: ctx.threadId,
    scopeKey,
    version: await service.nextVersion(ctx.workspaceId, scopeKey),
    provenance: stampProvenance(config.provenance(ctx), config.now),
  })
}

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
async function resolveEvidenceQuotes(
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
function assertClaimsSupported(
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
function assertTargetsNotCrossed(config: WorkProductToolConfig, entries: readonly EvidenceEntry[]): void {
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
async function summarizeQuoteVerification(
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
function summarizeClaimSupport(evidence: readonly EvidenceEntry[]): {
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
function summarizeTargetCorrectness(
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
function summarizeArtifactAgreement(
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

/** Build the three work-product tools for `customTools` registration on the
 *  MCP server / HTTP handler / runtime executor. */
export function buildWorkProductTools(config: WorkProductToolConfig): AppToolDefinition[] {
  const service = createWorkProductService({
    store: config.store,
    ...(config.now ? { now: config.now } : {}),
    ...(config.generateId ? { generateId: config.generateId } : {}),
  })

  const upsertEvidence = defineAppTool({
    name: 'upsert_evidence',
    description:
      'Record source→field lineage for the current work product, incrementally as you find it. Each entry links a source document (sourceRef + locator) to one artifact target and states the claim it supports. Cite by locator.find — the value exactly as it appears in the document — and the platform locates it and writes the supporting quote for you. Re-emitting an entry id replaces that entry. Address the work product by scopeKey; the first call creates the draft.',
    parameters: {
      type: 'object',
      properties: {
        scopeKey: { type: 'string', description: 'Engagement key for this work product.' },
        entries: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_WORK_PRODUCT_BATCH,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable entry id — re-emit to replace.' },
              sourceRef: { type: 'string', description: 'Vault path / attachment id of the SOURCE document.' },
              locator: {
                type: 'object',
                properties: {
                  page: { type: 'number' },
                  range: { type: 'string', description: "Free-form location: 'L120-L134' | 'B7' | '¶4'." },
                  find: {
                    type: 'string',
                    description:
                      'PREFERRED — use this whenever the value was READ from a document. The value exactly as it appears in the source (for example "128,450.00"), or a short distinctive phrase from the supporting line. The platform LOCATES it, cites the whole line it sits on, and returns that line to you. You do not retype the quote and you do not compute character offsets — so the citation can neither be invented nor land on the wrong line. If the value is not in the document, the entry is refused.',
                  },
                  findOccurrence: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Which occurrence of `find` to cite when the value appears more than once. Defaults to the first.',
                  },
                  span: {
                    type: 'object',
                    description:
                      'Only when you have exact character offsets from a tool that computed them. Absolute offsets into the whole document: start is the first character, end is one past the last. Prefer `find` — offsets computed by hand land on the wrong line.',
                    properties: {
                      start: { type: 'integer', minimum: 0 },
                      end: { type: 'integer', minimum: 1 },
                    },
                    required: ['start', 'end'],
                  },
                  quote: {
                    type: 'string',
                    description:
                      'Fallback for sources that cannot give you character offsets: the supporting text copied character-for-character. The platform checks it occurs in the document and REFUSES the entry if it does not. Prefer span. For a value you COMPUTED rather than read, omit both and state the computation in claim.',
                  },
                },
              },
              target: { type: 'string', description: 'Artifact field/claim this evidence supports.' },
              claim: { type: 'string', description: 'The value/assertion at the target.' },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
            },
            required: ['id', 'sourceRef', 'target', 'claim'],
          },
        },
      },
      required: ['scopeKey', 'entries'],
    },
    async execute(args: Record<string, unknown>, ctx: AppToolContext) {
      const scopeKey = requireScopeKey(args)
      const raw = requireBatch(args, 'entries')
      const entries: EvidenceEntry[] = []
      for (let index = 0; index < raw.length; index += 1) {
        const parsed = parseEvidenceInput(raw[index], `entries[${index}]`)
        if (!parsed.ok) throw new ToolInputError('invalid_evidence', `${parsed.field}: ${parsed.error}`)
        // Fold to the product's canonical target spelling at INGEST, so the
        // row never carries two names for one line. Every downstream check —
        // coverage, deduplication, artifact agreement, the confusable-target
        // groups — joins on this string.
        if (config.normalizeTarget) parsed.value.target = config.normalizeTarget(parsed.value.target)
        entries.push(parsed.value)
      }
      // Fail-loud source resolution: lineage can never point at nothing.
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]!
        if (!(await config.resolveSourceRef(entry.sourceRef, ctx))) {
          throw new ToolInputError(
            'unknown_source_ref',
            `entries[${index}].sourceRef: "${entry.sourceRef}" does not resolve to an existing source document.`,
          )
        }
      }
      // Fail-loud quote verification: a quote must occur in the document the
      // entry names. Rejected BEFORE the draft is resolved, so a batch with a
      // fabricated quote persists nothing — the model corrects and re-sends
      // rather than leaving a half-written row behind.
      await resolveEvidenceQuotes(config, entries, ctx)
      // ...and the text that resolution produced must carry the figure the
      // entry claims. Same batch, same fail-before-persist discipline: an
      // entry citing the payer line for a wage figure never reaches the draft.
      assertClaimsSupported(config, entries)
      // ...and that line must belong to the target it is attached to. A
      // citation carrying the right figure on a sibling's line passes every
      // gate above it and misleads a reviewer more effectively than a
      // fabricated one, because it survives being clicked.
      assertTargetsNotCrossed(config, entries)
      // NOTE: artifact agreement is deliberately NOT checked here. See
      // `summarizeArtifactAgreement` — comparing an incoming citation to a
      // STALE artifact deadlocks the one correction order an agent can take.
      const draft = await resolveDraft(service, config, scopeKey, ctx)
      const record = await unwrap(() => service.upsertEvidence(draft.id, entries), 'evidence_rejected')
      return {
        workProductId: record.id,
        version: record.version,
        evidenceCount: record.evidence.length,
        // Echo what was actually STORED for the entries in this call. A span
        // citation's quote is produced here, not sent here, so the model must
        // be able to see the text its offsets selected — that is how it
        // notices an off-by-a-line span without a second read.
        entries: entries.map((entry) => ({
          id: entry.id,
          target: entry.target,
          ...(entry.locator.quote === undefined ? {} : { quote: entry.locator.quote }),
          ...(entry.locator.quoteBasis === undefined ? {} : { quoteBasis: entry.locator.quoteBasis }),
        })),
      }
    },
  })

  const flagException = defineAppTool({
    name: 'flag_exception',
    description:
      'Flag problems with the current work product (missing documents, inconsistent sources, …). An unresolved blocking exception parks the work product until it is resolved; re-emit the same id with resolved:true to release it. Address by scopeKey.',
    parameters: {
      type: 'object',
      properties: {
        scopeKey: { type: 'string', description: 'Engagement key for this work product.' },
        exceptions: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_WORK_PRODUCT_BATCH,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable entry id — re-emit to replace.' },
              severity: { type: 'string', enum: ['blocking', 'material', 'advisory'] },
              kind: { type: 'string', description: 'Exception kind from the product vocabulary.' },
              message: { type: 'string' },
              targets: { type: 'array', items: { type: 'string' } },
              resolved: { type: 'boolean' },
              resolutionNote: { type: 'string' },
            },
            required: ['id', 'severity', 'kind', 'message'],
          },
        },
      },
      required: ['scopeKey', 'exceptions'],
    },
    async execute(args: Record<string, unknown>, ctx: AppToolContext) {
      const scopeKey = requireScopeKey(args)
      const raw = requireBatch(args, 'exceptions')
      const entries: ExceptionEntry[] = []
      for (let index = 0; index < raw.length; index += 1) {
        const parsed = parseExceptionInput(raw[index], `exceptions[${index}]`)
        if (!parsed.ok) throw new ToolInputError('invalid_exception', `${parsed.field}: ${parsed.error}`)
        if (!config.exceptionKinds.includes(parsed.value.kind)) {
          throw new ToolInputError(
            'invalid_exception',
            `exceptions[${index}].kind: must be one of: ${config.exceptionKinds.join(', ')}`,
          )
        }
        // An agent resolving its own exception is tagged as such; the reviewer
        // tag is reserved for the verdict route.
        if (parsed.value.resolved && parsed.value.resolvedBy === undefined) parsed.value.resolvedBy = 'agent'
        entries.push(parsed.value)
      }
      const draft = await resolveDraft(service, config, scopeKey, ctx)
      const record = await unwrap(() => service.upsertExceptions(draft.id, entries), 'exception_rejected')
      return {
        workProductId: record.id,
        version: record.version,
        status: record.status,
        unresolvedBlocking: unresolvedBlockingExceptions(record.exceptions).length,
      }
    },
  })

  const submitWorkProduct = defineAppTool({
    name: 'submit_work_product',
    description:
      'Submit the finished work product for professional review — the terminal call after evidence and exceptions are recorded. Refused while a blocking exception is unresolved, or when a material target lacks evidence. Include your own quality checks in `checks`.',
    parameters: {
      type: 'object',
      properties: {
        scopeKey: { type: 'string', description: 'Engagement key for this work product.' },
        artifact: {
          type: 'object',
          properties: {
            kind: { type: 'string', description: 'Artifact kind from the product vocabulary.' },
            title: { type: 'string' },
            path: { type: 'string', description: 'Vault/object-store ref of the rendered document.' },
            content: { type: 'string', description: 'Inline body when small (markdown/JSON).' },
            mediaType: { type: 'string' },
            baseline: {
              type: 'object',
              properties: { path: { type: 'string' }, content: { type: 'string' } },
              description: 'For diff-first artifacts: the source document being redlined.',
            },
            fields: { type: 'object', description: 'Structured field map lineage targets anchor to.' },
          },
          required: ['kind', 'title'],
        },
        checks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              passed: { type: 'boolean' },
              detail: { type: 'string' },
            },
            required: ['id', 'name', 'passed'],
          },
          description: 'Your own quality self-checks (recorded as agent-sourced).',
        },
      },
      required: ['scopeKey', 'artifact'],
    },
    async execute(args: Record<string, unknown>, ctx: AppToolContext) {
      const scopeKey = requireScopeKey(args)
      const parsedArtifact = parseArtifactInput(args.artifact)
      if (!parsedArtifact.ok) throw new ToolInputError('invalid_artifact', `${parsedArtifact.field}: ${parsedArtifact.error}`)
      const artifact = parsedArtifact.value
      if (!config.artifactKinds.includes(artifact.kind)) {
        throw new ToolInputError('invalid_artifact', `artifact.kind: must be one of: ${config.artifactKinds.join(', ')}`)
      }
      const agentChecks: QualityCheck[] = []
      if (args.checks !== undefined) {
        if (!Array.isArray(args.checks)) throw new ToolInputError('invalid_checks', 'checks must be an array when present.')
        for (let index = 0; index < args.checks.length; index += 1) {
          const parsed = parseAgentCheckInput(args.checks[index], `checks[${index}]`)
          if (!parsed.ok) throw new ToolInputError('invalid_checks', `${parsed.field}: ${parsed.error}`)
          agentChecks.push({ ...parsed.value, source: 'agent' })
        }
      }

      const draft = await resolveDraft(service, config, scopeKey, ctx)
      const blocking = unresolvedBlockingExceptions(draft.exceptions)
      if (blocking.length > 0) {
        throw new ToolInputError(
          'blocking_exceptions_unresolved',
          `Cannot submit: ${blocking.length} unresolved blocking exception(s) (${blocking.map((entry) => entry.id).join(', ')}). Resolve each via flag_exception with resolved:true, or downgrade its severity with a resolutionNote justifying why it does not block.`,
          409,
        )
      }

      // Platform check one: every persisted quote still occurs in the source
      // it names. The upsert gate stops NEW fabrication; this stops a package
      // whose evidence predates the gate from reaching a reviewer. Recorded on
      // the row AND rejected fail-loud — the same discipline as coverage.
      const checks: QualityCheck[] = [...agentChecks]
      const quotes = await summarizeQuoteVerification(config, draft.evidence, ctx)
      if (quotes) {
        const quoted = quotes.verified + quotes.failed.length
        checks.unshift({
          id: QUOTE_VERIFICATION_CHECK,
          name: QUOTE_VERIFICATION_CHECK,
          passed: quotes.failed.length === 0,
          detail:
            quotes.failed.length === 0
              ? `${quotes.verified}/${quoted} quoted evidence entries verified against their source (${quotes.spanAnchored} platform-sliced from a source span, ${quotes.verified - quotes.spanAnchored} model-quoted and proved to occur); ${quotes.withoutQuote} recorded without a quote`
              : `Unverifiable quotes on: ${quotes.failed.join(', ')}`,
          source: 'platform',
        })
        if (quotes.failed.length > 0) {
          await unwrap(() => service.recordChecks(draft.id, checks), 'checks_rejected')
          throw new ToolInputError(
            'quote_verification_failed',
            `Cannot submit: ${quotes.failed.length} evidence entr${quotes.failed.length === 1 ? 'y quotes' : 'ies quote'} text that does not occur in the source named (${quotes.failed.join(', ')}). Re-emit each with a quote copied character-for-character from that document, or without locator.quote if the value is computed.`,
          )
        }
      }

      // Platform check two: every citation's text carries the figure it
      // claims. Recorded AND rejected, like the other two — a citation that
      // points at real text supporting nothing is the failure a reviewer is
      // least able to catch by eye, because it looks exactly like a good one.
      if (config.verifyClaimSupport !== false) {
        const support = summarizeClaimSupport(draft.evidence)
        checks.unshift({
          id: CLAIM_SUPPORT_CHECK,
          name: CLAIM_SUPPORT_CHECK,
          passed: support.unsupported.length === 0,
          detail:
            support.unsupported.length > 0
              ? `Cited text does not contain the claimed figure on: ${support.unsupported.join(', ')}`
              : support.checkable === 0
                ? // Honest about a vacuous pass: no entry paired a quote with a
                  // figure, so nothing was checked. Reporting "0/0 verified"
                  // would read to a reviewer as assurance that was never earned.
                  'No citation pairs a quote with a claimed figure — nothing to check'
                : `${support.supported}/${support.checkable} value-bearing citations anchor to text containing the claimed figure`,
          source: 'platform',
        })
        if (support.unsupported.length > 0) {
          await unwrap(() => service.recordChecks(draft.id, checks), 'checks_rejected')
          throw new ToolInputError(
            'claim_not_supported',
            `Cannot submit: ${support.unsupported.length} evidence entr${support.unsupported.length === 1 ? 'y cites' : 'ies cite'} text that does not contain the figure claimed (${support.unsupported.join(', ')}). Re-emit each with locator.find set to the value exactly as it appears in the document, or without a locator if the figure was computed rather than read.`,
          )
        }
      }

      // Legacy rows carry whatever target spelling was current when they were
      // written, so every submit-time check folds on READ as well as ingest.
      const targetOf = (entry: EvidenceEntry): string =>
        config.normalizeTarget ? config.normalizeTarget(entry.target) : entry.target

      // Platform check three: every citation's line belongs to the target it
      // is attached to. Recorded AND rejected — a crossed citation is real
      // text carrying the real figure, so it is invisible to every gate above.
      if (config.confusableTargets && config.confusableTargets.length > 0) {
        const crossing = summarizeTargetCorrectness(draft.evidence, config.confusableTargets, targetOf)
        checks.unshift({
          id: TARGET_CORRECTNESS_CHECK,
          name: TARGET_CORRECTNESS_CHECK,
          passed: crossing.crossed.length === 0,
          detail:
            crossing.crossed.length > 0
              ? `Citations attached to the wrong target: ${crossing.crossed.map((item) => item.detail).join('; ')}`
              : crossing.checkable === 0
                ? 'No citation lands on a line this product can tell apart from a sibling target — nothing to check'
                : `${crossing.correct}/${crossing.checkable} citations land on a line belonging to their own target`,
          source: 'platform',
        })
        if (crossing.crossed.length > 0) {
          await unwrap(() => service.recordChecks(draft.id, checks), 'checks_rejected')
          throw new ToolInputError(
            'target_crossed',
            `Cannot submit: ${crossing.crossed.length} evidence entr${crossing.crossed.length === 1 ? 'y cites' : 'ies cite'} a line belonging to a different target — ${crossing.crossed.map((item) => item.detail).join('; ')}. Re-emit each against the target whose line it actually cites, or cite the line that belongs to the target it is attached to.`,
          )
        }
      }

      // Platform check four: the evidence and the artifact must agree about
      // what each line holds. This is the pass that catches a package whose
      // crossed evidence predates the artifact it decorates — every entry was
      // recorded turns before there was an artifact to compare it to.
      const artifactValues = indexArtifactValues(artifact.fields, config.normalizeTarget)
      if (config.verifyArtifactAgreement !== false && artifactValues.size > 0) {
        const agreement = summarizeArtifactAgreement(draft.evidence, artifactValues, targetOf)
        checks.unshift({
          id: ARTIFACT_AGREEMENT_CHECK,
          name: ARTIFACT_AGREEMENT_CHECK,
          passed: agreement.contradicting.length === 0,
          detail:
            agreement.contradicting.length > 0
              ? `Evidence contradicts the artifact on: ${agreement.contradicting.map((item) => item.detail).join('; ')}`
              : agreement.checkable === 0
                ? 'No evidence claim states a figure the artifact also states — nothing to check'
                : `${agreement.agreeing}/${agreement.checkable} evidence claims agree with the artifact field they support`,
          source: 'platform',
        })
        if (agreement.contradicting.length > 0) {
          await unwrap(() => service.recordChecks(draft.id, checks), 'checks_rejected')
          throw new ToolInputError(
            'contradicts_artifact',
            `Cannot submit: ${agreement.contradicting.length} evidence entr${agreement.contradicting.length === 1 ? 'y contradicts' : 'ies contradict'} the artifact they support — ${agreement.contradicting.map((item) => item.detail).join('; ')}. Move each citation to the target it actually supports, or correct the artifact. The package cannot state both.`,
          )
        }
      }

      // Platform check five: every material target has ≥1 evidence row. A
      // failing coverage check is BOTH recorded on the row (visible to the
      // queue) and rejected fail-loud — a lineage-free package can never reach
      // a reviewer.
      if (config.materialTargets) {
        // Both sides of the join fold to the canonical spelling: an artifact
        // field written `line_3a` and an evidence row written `f1040.line_3a`
        // are one line, and a coverage check that read them as two would
        // report a miss on a target that IS evidenced.
        const targets = [
          ...new Set(
            config.materialTargets(artifact).map((target) => (config.normalizeTarget ? config.normalizeTarget(target) : target)),
          ),
        ]
        const covered = new Set(draft.evidence.map(targetOf))
        const missing = targets.filter((target) => !covered.has(target))
        // How each covered target is BACKED, not merely that a row exists.
        // A coverage count that cannot distinguish a platform-sliced citation
        // from a bare assertion is the number that let 13 invented quotes read
        // as "13/13 evidenced" on the row a reviewer then opened.
        const anchoredTargets = new Set(
          draft.evidence.filter((entry) => entry.locator.quoteBasis !== undefined).map(targetOf),
        )
        const spanTargets = new Set(
          draft.evidence.filter((entry) => entry.locator.quoteBasis === 'span').map(targetOf),
        )
        const present = targets.filter((target) => covered.has(target))
        const unanchored = present.filter((target) => !anchoredTargets.has(target))
        const spanCount = present.filter((target) => spanTargets.has(target)).length
        const breakdown = `${spanCount} span-anchored, ${present.length - spanCount - unanchored.length} quote-verified, ${unanchored.length} claim-only`
        const coverage: QualityCheck = {
          id: EVIDENCE_COVERAGE_CHECK,
          name: EVIDENCE_COVERAGE_CHECK,
          passed: missing.length === 0 && !(config.requireAnchoredEvidence && unanchored.length > 0),
          detail:
            missing.length > 0
              ? `Missing evidence for: ${missing.join(', ')}`
              : config.requireAnchoredEvidence && unanchored.length > 0
                ? `No source anchor for: ${unanchored.join(', ')}`
                : `${targets.length}/${targets.length} material targets evidenced (${breakdown})`,
          source: 'platform',
        }
        checks.unshift(coverage)
        if (missing.length > 0) {
          await unwrap(() => service.recordChecks(draft.id, checks), 'checks_rejected')
          throw new ToolInputError(
            'evidence_coverage_failed',
            `Cannot submit: material targets lack evidence: ${missing.join(', ')}. Add upsert_evidence entries targeting each, then resubmit.`,
          )
        }
        if (config.requireAnchoredEvidence && unanchored.length > 0) {
          await unwrap(() => service.recordChecks(draft.id, checks), 'checks_rejected')
          throw new ToolInputError(
            'evidence_not_anchored',
            `Cannot submit: these material targets have an evidence row but no source anchor: ${unanchored.join(', ')}. Re-emit each with locator.find — the value exactly as it appears in the document. The platform locates it and writes the quote itself, so you never retype source text or count characters.`,
          )
        }
      }

      const provenance = stampProvenance(config.provenance(ctx), config.now)
      const record = await unwrap(
        () => service.submit(draft.id, { artifact, checks, provenance }),
        'submit_rejected',
      )
      await config.onReady?.(record, ctx)
      return {
        workProductId: record.id,
        version: record.version,
        status: record.status,
        checks: record.checks.map((check) => ({ name: check.name, passed: check.passed, source: check.source })),
      }
    },
  })

  return [upsertEvidence, flagException, submitWorkProduct]
}
