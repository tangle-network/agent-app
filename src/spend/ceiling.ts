import type { CeilingBasis, ExpectedCeiling, SpendBoxRecord } from './types'

/**
 * Slack allowed between the product's bound and what the platform settled,
 * before an overage is called a discrepancy. 15 minutes.
 *
 * Not a guess: it is the platform's OWN staleness threshold for compute
 * settlement. Its runbook clears an incident when
 * `/health computeSettlement.oldestAgeSeconds` is "back under 900" — so 900 s is
 * the age the platform itself treats as normal settlement lag, and anything
 * inside it is drift the platform has already declared acceptable. Below that a
 * product would alert on the platform's ordinary queue behaviour; far above it
 * the tolerance starts eating the signal, because the idle window it must stay
 * well under is 3600 s in every shipped product.
 *
 * It is a caller parameter because a product that asks for a shorter idle
 * timeout must shrink this with it.
 */
export const DEFAULT_CEILING_TOLERANCE_MS = 900_000

export interface ComputeExpectedCeilingOptions {
  /** The instant the reconciliation treats as "now", epoch ms. */
  readonly asOf: number
  /** Slack before an overage counts. Default {@link DEFAULT_CEILING_TOLERANCE_MS}. */
  readonly toleranceMs?: number
}

/**
 * The upper bound on how long one box could honestly have been billable.
 *
 * The whole design constraint is that this must stay an UPPER bound under
 * everything the product cannot see. Three such blind spots exist, and they
 * pull in different directions:
 *
 * - **Platform-side suspends.** The platform can park a box the product never
 *   hears about. That only ever REDUCES real billable time, so an upper bound
 *   is unaffected and nothing here widens for it.
 * - **Detached runs.** The product dispatches work and disconnects. The box
 *   keeps working — and billing — after the last activity the product saw, so
 *   `lastActivityAt` understates the truth. An unfinished detached run
 *   therefore abandons the activity-based bound entirely rather than reporting
 *   a bound it cannot support.
 * - **Reconnects.** A browser or worker re-attaches and work resumes. This
 *   needs no special case: a reconnect is recorded as activity, the fold takes
 *   the max, and the horizon moves out on its own.
 *
 * The bound that rescues the detached case is `maxLifetimeSeconds`. The platform
 * destroys the box at `createdAt + maxLifetimeSeconds` no matter what anyone
 * observed, so a product that asks for one holds a hard bound that survives
 * every blind spot above. Both shipped products ask for 86 400 s, which is why
 * the incident — 124 to 268 hours settled against boxes with a 24-hour
 * lifetime — is detectable with no lifecycle bookkeeping at all.
 */
export function computeExpectedCeiling(
  record: SpendBoxRecord,
  options: ComputeExpectedCeilingOptions,
): ExpectedCeiling {
  const toleranceMs = options.toleranceMs ?? DEFAULT_CEILING_TOLERANCE_MS
  const { asOf } = options

  let basis: CeilingBasis
  let horizonAt: number

  if (record.deletedAt !== null) {
    basis = 'deleted'
    horizonAt = record.deletedAt
  } else if (record.stoppedAt !== null) {
    basis = 'stopped'
    horizonAt = record.stoppedAt
  } else if (record.openDetachedRunIds.length > 0) {
    // Nothing the product observed bounds this box. Fall back to the
    // reconciliation instant, and say so through `bounded: false`.
    basis = 'open-detached-run'
    horizonAt = asOf
  } else {
    basis = 'idle-timeout'
    horizonAt = record.lastActivityAt + record.idleTimeoutSeconds * 1000
  }

  // The hard platform bound wins whenever it is tighter — including over an
  // unfinished detached run, which is what turns an unbounded box back into a
  // bounded one.
  if (record.maxLifetimeSeconds !== null) {
    const lifetimeHorizon = record.createdAt + record.maxLifetimeSeconds * 1000
    if (lifetimeHorizon < horizonAt) {
      basis = 'max-lifetime'
      horizonAt = lifetimeHorizon
    }
  }

  // Time that has not elapsed cannot have been billed, so an idle window
  // reaching into the future does not widen the bound. This only ever tightens
  // the ceiling, so it cannot mask a charge.
  if (horizonAt > asOf) horizonAt = asOf
  // A horizon before creation would produce a negative ceiling; a box is at
  // minimum billable for the instant it existed.
  if (horizonAt < record.createdAt) horizonAt = record.createdAt

  return {
    sandboxId: record.sandboxId,
    basis,
    horizonAt,
    ceilingMs: horizonAt - record.createdAt + toleranceMs,
    toleranceMs,
    bounded: basis !== 'open-detached-run',
  }
}
