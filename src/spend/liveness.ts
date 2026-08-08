import { computeExpectedCeiling } from './ceiling'
import type {
  SpendBoxLiveness,
  SpendBoxRecord,
  SpendExpectationSummary,
  SpendReport,
  SpendWindow,
} from './types'

/**
 * Expectation liveness: what the product BELIEVES it should have been billed for.
 *
 * ## The hole this closes
 *
 * `reconcileSpend` compares settlements against expectations, and every one of
 * its rules is driven by a settlement row. That makes it able to answer exactly
 * one direction of the question:
 *
 * > were we billed for something we did not ask for, or for more than allowed?
 *
 * It cannot answer the other direction — *were we NOT billed for something we
 * DID ask for* — because with no row there is nothing to iterate. Three real
 * shapes fall straight through that hole and every one of them renders as a
 * clean bill:
 *
 * - the expectation ledger names no box, so the pass examines nobody → `ok:true`;
 * - the billing endpoint quietly starts returning zero rows → `ok:true`,
 *   `rowsExamined:0`;
 * - a stale or rotated key list excludes every box → `ok:true` with everything
 *   `foreign`.
 *
 * In all three the check stopped checking while looking green. That is the exact
 * failure class the module exists to prevent, reproduced inside the module.
 *
 * ## The discriminator, and why it is not a new store
 *
 * The expectation ledger already records the only fact needed: when the product
 * first saw a box (`createdAt`), the last work it observed (`lastActivityAt`),
 * and any stop or delete it knows about. Those are precisely the inputs
 * {@link computeExpectedCeiling} already folds into a horizon — the latest
 * instant a box could still have been billable. So a box's LIVE INTERVAL is
 * `[createdAt, horizon]`, derived from the same fold the ceiling uses rather
 * than from a second, drift-prone definition of "running".
 *
 * A box whose live interval overlaps the reconciliation window is a box the
 * product expected to be billed for. The absence of a settlement against it is
 * then a first-class outcome, not silence.
 *
 * ## Why the grace period is load-bearing
 *
 * Settlement lags provisioning. A box that came up ninety seconds before the
 * window closed has no settlement yet and never should have — expecting one
 * would manufacture a finding out of the platform's ordinary queue behaviour.
 * So expectation is asserted only for boxes with at least
 * {@link DEFAULT_EXPECTATION_GRACE_MS} of live time INSIDE the window, which is
 * the platform's own declared-normal settlement lag (see the constant).
 *
 * The asymmetry the rest of the module runs on holds here too, but it points the
 * other way and that is deliberate: an over-tight liveness derivation produces a
 * false ALARM about the check, never a false clean bill. Nothing in this file
 * can make a report cleaner than it would otherwise be.
 */

/**
 * How much live time a box needs inside the window before a settlement is
 * EXPECTED for it. 15 minutes.
 *
 * Same number and same justification as {@link DEFAULT_CEILING_TOLERANCE_MS},
 * arrived at from the other side: the platform's runbook clears a compute
 * settlement incident when `/health computeSettlement.oldestAgeSeconds` is "back
 * under 900", so 900 s is lag the platform has already declared normal. A box
 * live for less than that inside the window may legitimately have settled
 * nothing yet, and demanding a row for it would report the platform's own queue
 * as a defect.
 *
 * A caller parameter, because a product reconciling a very short window must
 * shrink it or the window expects nothing at all.
 */
export const DEFAULT_EXPECTATION_GRACE_MS = 900_000

/** Options for {@link boxLivenessInWindow}. */
export interface BoxLivenessOptions {
  /** Live ms inside the window before a settlement is expected. Default {@link DEFAULT_EXPECTATION_GRACE_MS}. */
  readonly graceMs?: number
}

/** Reject a window that cannot be reconciled, rather than examining nobody inside it. */
export function assertSpendWindow(window: SpendWindow): void {
  if (!Number.isFinite(window.startAt) || !Number.isFinite(window.endAt)) {
    throw new Error('spend window needs finite `startAt` and `endAt` epoch-ms instants')
  }
  if (window.endAt <= window.startAt) {
    throw new Error(
      `spend window ends at or before it starts (${new Date(window.startAt).toISOString()} → ` +
        `${new Date(window.endAt).toISOString()}): a zero-width window expects nothing and would ` +
        'certify an unchecked account.',
    )
  }
}

/**
 * One box's live interval, and whether the product should have been billed for
 * it inside this window.
 *
 * The live interval's end is {@link computeExpectedCeiling}'s horizon evaluated
 * at the window's end — the SAME derivation the ceiling check uses, so a box
 * cannot be considered live here and dead there. `toleranceMs` is zero because
 * tolerance is slack allowed to the PLATFORM's clock, and widening a box's life
 * by it would expect settlements for boxes that were already gone.
 */
export function boxLivenessInWindow(
  record: SpendBoxRecord,
  window: SpendWindow,
  options: BoxLivenessOptions = {},
): SpendBoxLiveness {
  const graceMs = options.graceMs ?? DEFAULT_EXPECTATION_GRACE_MS
  const ceiling = computeExpectedCeiling(record, { asOf: window.endAt, toleranceMs: 0 })

  const liveFrom = record.createdAt
  const liveUntil = ceiling.horizonAt
  const overlaps = liveFrom <= window.endAt && liveUntil >= window.startAt
  const overlapStart = Math.max(liveFrom, window.startAt)
  const overlapEnd = Math.min(liveUntil, window.endAt)
  const liveMsInWindow = overlaps ? Math.max(0, overlapEnd - overlapStart) : 0

  return {
    sandboxId: record.sandboxId,
    workspaceId: record.workspaceId,
    liveFrom,
    liveUntil,
    basis: ceiling.basis,
    overlaps,
    liveMsInWindow,
    expectSettlement: overlaps && liveMsInWindow >= graceMs,
  }
}

/** Why {@link assessAllExcluded} answered the way it did. */
export type AllExcludedBasis =
  /** Not every box was excluded — the pass examined some of this product's own. */
  | 'not-all-excluded'
  /** Boxes of this product's were live in the window, so an all-foreign pass is wrong. */
  | 'expected-boxes-live'
  /** Expectation was declared and nothing was live: an idle product, not a defect. */
  | 'nothing-expected'
  /** No expectation was declared, so the question cannot be answered. Fails closed. */
  | 'not-declared'

/** {@link assessAllExcluded}'s verdict, with the reason a pager message needs. */
export interface AllExcludedAssessment {
  /** True when the caller should raise. */
  readonly pathological: boolean
  readonly basis: AllExcludedBasis
  /** One sentence naming the numbers behind the verdict. */
  readonly reason: string
}

/**
 * Should "we saw settlements but none of them were ours" page a human?
 *
 * Consumers raise this pathology on `boxesExamined > 0 && ownedBoxes === 0`.
 * That shape has two completely different causes and the naive test cannot tell
 * them apart:
 *
 * - an ownership rule that has gone stale — a rotated key, a new deployment key
 *   nobody added — so every one of the product's OWN boxes now reads as a
 *   sibling's. The check has stopped checking.
 * - a product that was legitimately idle while a sibling settled on the same
 *   wallet. Nothing is wrong, and paging on it pages EVERY day the product is
 *   quiet, which is how a real alert gets muted.
 *
 * The discriminator is expectation liveness: did this product have a box alive
 * during the window? Only then is an all-excluded pass pathological.
 *
 * Fails closed when no expectation was declared — that is today's behaviour, and
 * a pass that cannot answer the question must not answer it optimistically. The
 * `reason` says so, and the fix (declare `window`, implement `listLiveBetween`)
 * is in the string a human reads.
 */
export function assessAllExcluded(report: SpendReport): AllExcludedAssessment {
  const { ownership, expectation } = report
  if (report.boxesExamined === 0 || ownership.ownedBoxes > 0) {
    return {
      pathological: false,
      basis: 'not-all-excluded',
      reason:
        `${report.boxesExamined} box(es) examined, ${ownership.ownedBoxes} claimed as this ` +
        'product\'s — this pass looked at its own settlements.',
    }
  }
  if (!expectation.declared) {
    return {
      pathological: true,
      basis: 'not-declared',
      reason:
        `every one of the ${report.boxesExamined} settled box(es) was excluded as another ` +
        'product\'s, and no expectation was declared — so an over-narrow ownership rule and a ' +
        'genuinely idle product are indistinguishable here. Raised fail-closed; declare `window` ' +
        'and implement `listLiveBetween` on the expectation store to make this answerable.',
    }
  }
  if (expectation.expectedBoxes === 0) {
    return {
      pathological: false,
      basis: 'nothing-expected',
      reason:
        `every one of the ${report.boxesExamined} settled box(es) was excluded as another ` +
        `product's, and this product had no box live in the window (${expectation.liveBoxes} ` +
        'overlapping, 0 live long enough to expect a bill) — an idle product beside a busy ' +
        'sibling, not a broken rule.',
    }
  }
  return {
    pathological: true,
    basis: 'expected-boxes-live',
    reason:
      `every one of the ${report.boxesExamined} settled box(es) was excluded as another ` +
      `product's (${ownership.label ?? 'no rule'}) while this product had ${expectation.expectedBoxes} ` +
      'box(es) live in the window — its own settlements should have been in there.',
  }
}

/** The expectation summary a pass that declared none reports. Loud, never absent. */
export function undeclaredExpectation(graceMs: number): SpendExpectationSummary {
  return {
    declared: false,
    window: null,
    graceMs,
    liveBoxes: 0,
    expectedBoxes: 0,
    settledBoxes: 0,
    unsettledSandboxIds: [],
  }
}
