/**
 * Optional reconcilers for `guarantee: 'reconciled'`.
 *
 * Read this before wiring one, because the honest ceiling here is lower than it
 * looks and the difference is a correctness matter, not a documentation nicety.
 *
 * ## What the transport can and cannot tell us
 *
 * The sidecar exposes exactly two operations: list the asks still OUTSTANDING,
 * and submit an answer. There is no lookup that reports whether a specific
 * payload committed. So the strongest question an external reconciler can ask is
 * "is this ask still pending?", and a "no" means only that SOMETHING settled it
 * — this answer, a different one from another tab, a cancel, or a timeout.
 *
 * ## Why this is not the default
 *
 * `createInteractionAnswerRoute` calls `reconcile` from two places, and absence
 * means opposite things at each:
 *
 *  - **After a failed POST.** The ask was outstanding, we submitted, the
 *    submission errored, and the ask is now gone. Absence is genuine evidence
 *    that something consumed the answer.
 *  - **Before any POST**, when the ask was already missing from the pre-answer
 *    snapshot. Here absence is the PREMISE for calling reconcile at all.
 *    Answering "it's absent, so it settled" is circular: it would finalize an
 *    intent whose answer may never have been submitted, writing this attempt's
 *    payload into the transcript on the strength of no evidence whatsoever.
 *
 * The seam does not distinguish the two call sites, so a reconciler built on
 * absence cannot be safe by default. It is opt-in, and a product should wire it
 * only where a settled-by-someone-else outcome is acceptable.
 *
 * ## What you probably want instead
 *
 * Nothing. Crash recovery for the common case is already automatic and needs no
 * reconciler at all: the durable answer-intent journal records `acknowledged`
 * only after a successful POST, so a retry with the same `attemptKey` proves
 * delivery from local state. See `DurableInteractionGuarantee`.
 */

import type { DurableAnswerIntentRecord, DurableChatScope, DurableInteractionAcknowledgement } from './types'

/** The outstanding-ask snapshot a reconciler reasons about. */
export interface SidecarAbsenceReconcilerArgs {
  scope: DurableChatScope
  intent: DurableAnswerIntentRecord
  /** Ask ids the sidecar still considers outstanding. */
  outstanding: readonly { id: string }[]
}

/** Options for `createSidecarAbsenceReconciler`. */
export interface SidecarAbsenceReconcilerOptions {
  /**
   * Re-read the outstanding asks at reconcile time. Supply this when the caller
   * only has the PRE-answer snapshot: a stale snapshot makes the check
   * meaningless, since the ask's disappearance is exactly the event of interest.
   */
  listOutstanding?: (scope: DurableChatScope) => Promise<readonly { id: string }[]>
  now?: () => string
}

/**
 * Treat an ask that is no longer outstanding as settled.
 *
 * Returns `null` — leaving the intent prepared for a later durable retry — when
 * the ask is still pending, which is the honest answer for "not yet".
 *
 * The acknowledgement it produces is deliberately labelled
 * `absent-from-registry` rather than something that reads like a confirmed
 * receipt, so an operator reading a settled row can tell what was actually
 * verified. Wire it ONLY where "somebody settled this ask" is good enough; see
 * the module comment for when that is not true.
 */
export function createSidecarAbsenceReconciler(
  options: SidecarAbsenceReconcilerOptions = {},
): (args: SidecarAbsenceReconcilerArgs) => Promise<DurableInteractionAcknowledgement | null> {
  const now = options.now ?? (() => new Date().toISOString())

  return async ({ scope, intent, outstanding }) => {
    const current = options.listOutstanding ? await options.listOutstanding(scope) : outstanding
    const stillPending = current.some((item) => item.id === intent.interactionId)
    if (stillPending) return null
    return { acknowledged: true, status: 'absent-from-registry', at: now() }
  }
}
