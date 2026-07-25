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

/** The shell's one generic platform check: every material target has ≥1
 *  evidence row. Recorded as `QualityCheck{source:'platform'}`. */
export const EVIDENCE_COVERAGE_CHECK = 'evidence_coverage'

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
  /** The material targets the platform coverage check requires evidence for.
   *  Product-owned vocabulary; omit to skip the coverage gate. */
  materialTargets?: (artifact: WorkProductArtifact) => string[]
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
      'Record source→field lineage for the current work product, incrementally as you find it. Each entry links a source document (sourceRef + locator) to one artifact target and states the claim it supports. Re-emitting an entry id replaces that entry. Address the work product by scopeKey; the first call creates the draft.',
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
                  quote: { type: 'string', description: 'Verbatim supporting quote.' },
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
      const draft = await resolveDraft(service, config, scopeKey, ctx)
      const record = await unwrap(() => service.upsertEvidence(draft.id, entries), 'evidence_rejected')
      return { workProductId: record.id, version: record.version, evidenceCount: record.evidence.length }
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

      // The shell's ONE generic platform check: every material target has ≥1
      // evidence row. A failing coverage check is BOTH recorded on the row
      // (visible to the queue) and rejected fail-loud — a lineage-free package
      // can never reach a reviewer.
      const checks: QualityCheck[] = [...agentChecks]
      if (config.materialTargets) {
        const targets = config.materialTargets(artifact)
        const covered = new Set(draft.evidence.map((entry) => entry.target))
        const missing = targets.filter((target) => !covered.has(target))
        const coverage: QualityCheck = {
          id: EVIDENCE_COVERAGE_CHECK,
          name: EVIDENCE_COVERAGE_CHECK,
          passed: missing.length === 0,
          detail:
            missing.length === 0
              ? `${targets.length}/${targets.length} material targets evidenced`
              : `Missing evidence for: ${missing.join(', ')}`,
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
