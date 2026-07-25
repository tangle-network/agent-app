/**
 * Provenance stamping — the backtest spine. Every version of every work
 * product carries `profileHash + runId + servingModels`, stamped at the two
 * honest moments:
 *
 *  1. At dispatch, the product route composes the turn's profile and computes
 *     agent-eval's `agentProfileHash(profile)` — the SAME hash that keys the
 *     app's scorecard cells — and closes it (plus runId/sessionId) into the
 *     `provenance` seam `buildWorkProductTools` receives, so the model can
 *     neither omit nor forge it.
 *  2. At turn completion, the route's existing lifecycle seam calls
 *     {@link finalizeWorkProductProvenance}: serving model and cost come from
 *     the usage receipt, because only the completed turn knows what actually
 *     served. `servingModels` is honestly EMPTY until then.
 *
 * The trust bridge ({@link workProductTrustInputs}) maps judge-sourced
 * quality verdicts into `/eval-campaign`'s `trustVerdicts()` input with
 * type-only imports — products call `trustVerdicts` from
 * `@tangle-network/agent-app/eval-campaign` (which they already import for
 * their ensemble loop). Deliberately NOT a value re-export here: it would put
 * agent-eval's runtime on `/work-product`'s import path and drag the eval
 * engine into every product worker bundle.
 */

import type { JudgeVerdict } from '@tangle-network/agent-eval'
import type { TrustItem } from '../eval-campaign/trust-gate'
import type {
  WorkProductProvenance,
  WorkProductRecord,
  WorkProductStorePort,
} from './types'

export type { TrustItem }

/** The dispatch-time provenance closure's output: everything the route knows
 *  before the turn completes. */
export type WorkProductProvenanceBase = Omit<WorkProductProvenance, 'servingModels' | 'producedAt'>

/** Stamp a full provenance from the dispatch-time base. `servingModels` starts
 *  empty (honestly absent — never guessed) until the completion back-fill. */
export function stampProvenance(base: WorkProductProvenanceBase, now: () => number = Date.now): WorkProductProvenance {
  return { ...base, servingModels: [], producedAt: now() }
}

/** Completion receipt for one run, from the turn's usage/lifecycle seam. */
export interface FinalizeWorkProductProvenanceInput {
  workspaceId: string
  /** The chat turnId / mission-step run id the records were stamped with. */
  runId: string
  /** What actually served, from the usage receipt / serving-model header. */
  servingModels: readonly string[]
  costUsd?: number
  logger?: Pick<Console, 'warn'>
}

/**
 * Back-fill `servingModels`/`costUsd` onto every record (and its history
 * entries) stamped with `runId` — wire it into the chat route's existing
 * `lifecycle.onTurnComplete` seam; no new hook. Returns the updated records.
 * A CAS miss on one record is logged and skipped (the next completion or a
 * re-read re-applies); it never throws mid-fleet.
 */
export async function finalizeWorkProductProvenance(
  store: WorkProductStorePort,
  input: FinalizeWorkProductProvenanceInput,
): Promise<WorkProductRecord[]> {
  const rows = await store.listByWorkspace(input.workspaceId)
  const updated: WorkProductRecord[] = []
  for (const record of rows) {
    const recordMatches = record.provenance.runId === input.runId
    const historyMatches = record.history.some((entry) => entry.provenance.runId === input.runId)
    if (!recordMatches && !historyMatches) continue
    const finalize = (provenance: WorkProductProvenance): WorkProductProvenance => ({
      ...provenance,
      servingModels: [...input.servingModels],
      ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd }),
    })
    const next = await store.update(
      record.id,
      { status: record.status, version: record.version },
      {
        ...(recordMatches ? { provenance: finalize(record.provenance) } : {}),
        history: record.history.map((entry) =>
          entry.provenance.runId === input.runId ? { ...entry, provenance: finalize(entry.provenance) } : entry,
        ),
      },
    )
    if (!next) {
      input.logger?.warn(`[work-product] provenance back-fill lost a race on ${record.id}; skipped`)
      continue
    }
    await store.appendEvent({
      workProductId: record.id,
      workspaceId: record.workspaceId,
      step: 'wp.provenance',
      message: `Serving models back-filled for run ${input.runId}`,
      metadata: { runId: input.runId, servingModels: [...input.servingModels], costUsd: input.costUsd ?? null },
      at: Date.now(),
    })
    updated.push(next)
  }
  return updated
}

/**
 * Trust-gate bridge: one `TrustItem` per work product whose production
 * quality was scored by the product's eval-campaign ensemble. `verdictsFor`
 * returns the per-judge raw verdicts the product retained for a record (the
 * same verdicts `aggregateJudgeVerdicts` reduces); records without verdicts
 * are omitted. Feed the result to `/eval-campaign`'s `trustVerdicts()` —
 * an untrusted verdict renders as "quality: unverified", never a naked
 * number. Zero statistics code here: pure mapping.
 */
export function workProductTrustInputs<D extends string = string>(
  records: readonly WorkProductRecord[],
  verdictsFor: (record: WorkProductRecord) => readonly JudgeVerdict<D>[] | undefined,
): TrustItem<D>[] {
  const items: TrustItem<D>[] = []
  for (const record of records) {
    const verdicts = verdictsFor(record)
    if (!verdicts || verdicts.length === 0) continue
    items.push({ itemId: record.id, verdicts })
  }
  return items
}
