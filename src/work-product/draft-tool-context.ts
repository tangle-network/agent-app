import { ToolInputError } from '../tools/errors'
import type { AppToolContext } from '../tools/types'
import { stampProvenance } from './provenance'
import type { WorkProductOutcome, WorkProductService } from './service'
import { MAX_WORK_PRODUCT_BATCH, type WorkProductToolConfig } from './tool-config'
import type { WorkProductRecord } from './types'

/** Unwrap a guarded outcome, retrying ONCE on a lost race (the single
 *  serialized turn owner makes real contention rare; one re-read-and-retry
 *  absorbs the benign case). A deterministic rejection maps to a correctable
 *  `ToolInputError` so the model learns exactly why. */
export async function unwrap<T>(
  run: () => Promise<WorkProductOutcome<T>>,
  code: string,
): Promise<T> {
  let outcome = await run()
  if (!outcome.succeeded && outcome.conflict) outcome = await run()
  if (!outcome.succeeded) throw new ToolInputError(code, outcome.error, outcome.conflict ? 409 : 400)
  return outcome.value
}

export function requireScopeKey(args: Record<string, unknown>): string {
  const scopeKey = typeof args.scopeKey === 'string' ? args.scopeKey.trim() : ''
  if (!scopeKey) throw new ToolInputError('missing_scope_key', 'scopeKey is required — the engagement key this work product belongs to.')
  return scopeKey
}

export function requireBatch(args: Record<string, unknown>, field: string): unknown[] {
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
export async function resolveDraft(
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

