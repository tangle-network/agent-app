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
import { sliceSourceSpan, sourceContainsQuote, type SourceSpanFailure } from './quote'
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
    const span = entry.locator.span
    const quote = entry.locator.quote

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
        `entries[${index}].locator.quote: ${JSON.stringify(quote)} does not occur in "${entry.sourceRef}". Cite locator.span {start, end} instead — the character range you read it at, which this platform slices out of the document itself so the text is right by construction. If the value is COMPUTED rather than read, omit both and state the computation in claim.`,
      )
    }
    entry.locator.quoteBasis = 'model'
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
      'Record source→field lineage for the current work product, incrementally as you find it. Each entry links a source document (sourceRef + locator) to one artifact target and states the claim it supports. Cite by locator.span {start, end} — the character range you read the value at — and the platform slices the supporting quote out of the document for you. Re-emitting an entry id replaces that entry. Address the work product by scopeKey; the first call creates the draft.',
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
                  span: {
                    type: 'object',
                    description:
                      'PREFERRED. The character range you read the value at, as absolute offsets into the whole document: start is the first character, end is one past the last. If you read with an offset, add that offset to the position within the text you got back. The platform slices the quote out of the document itself and stores it, and returns it to you — you never retype source text, so the citation cannot be wrong. Use this whenever the value was READ from a document.',
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

      // Platform check two: every material target has ≥1 evidence row. A
      // failing coverage check is BOTH recorded on the row (visible to the
      // queue) and rejected fail-loud — a lineage-free package can never reach
      // a reviewer.
      if (config.materialTargets) {
        const targets = config.materialTargets(artifact)
        const covered = new Set(draft.evidence.map((entry) => entry.target))
        const missing = targets.filter((target) => !covered.has(target))
        // How each covered target is BACKED, not merely that a row exists.
        // A coverage count that cannot distinguish a platform-sliced citation
        // from a bare assertion is the number that let 13 invented quotes read
        // as "13/13 evidenced" on the row a reviewer then opened.
        const anchoredTargets = new Set(
          draft.evidence.filter((entry) => entry.locator.quoteBasis !== undefined).map((entry) => entry.target),
        )
        const spanTargets = new Set(
          draft.evidence.filter((entry) => entry.locator.quoteBasis === 'span').map((entry) => entry.target),
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
            `Cannot submit: these material targets have an evidence row but no source anchor: ${unanchored.join(', ')}. Re-emit each with locator.span {start, end} — the character range in the document you read the value at. The platform slices the quote out of the document itself, so you never retype source text.`,
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
