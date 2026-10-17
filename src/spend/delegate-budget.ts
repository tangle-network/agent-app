/**
 * The budget-derived delegated mint — the platform's reservation contract as
 * one function.
 *
 * The platform RESERVES a delegated child key's budget against its parent's
 * REMAINING budget: an ask above remaining is a hard refusal (no amounts in
 * the response), which is how every delegated mint in a fleet product died
 * until the derivation landed (hardware-agent #165, 2026-10-09: a flat $25
 * default asked of a $5-remaining parent refused 100% of mints). Products
 * that mint delegated keys must derive the ask from what the platform
 * actually guarantees:
 *
 *   - the parent's remaining budget is UNKNOWN → the configured ask stands
 *     (the platform isn't reporting a ceiling; nothing better is knowable);
 *   - remaining ≤ 0 → refuse with a correctable top-up error, before any
 *     mint is attempted;
 *   - otherwise → ask min(configured, remaining) floored to whole cents,
 *     never below the platform's minimum child budget (the floor keeps the
 *     mint VALID — a below-minimum ask is refused by the key API).
 *
 * Note the boundary honestly: with remaining between $0.01 and the minimum,
 * the derived ask (the floor) still exceeds remaining and the platform will
 * refuse it — that case is indistinguishable from exhausted for the caller
 * and surfaces through the same error path with the numbers attached.
 */

/** The platform's minimum child-key budget. Asks below it are refused by the
 *  key API, so the derivation never produces one. */
export const MIN_CHILD_KEY_BUDGET_USD = 0.5

/** The source key is exhausted — the only refusal this contract throws.
 *  Correctable by design: both numbers the decision used are on the error. */
export class ParentBudgetExhaustedError extends Error {
  readonly requestedUsd: number
  readonly parentRemainingUsd: number

  constructor(requestedUsd: number, parentRemainingUsd: number) {
    super(
      `workspace source key has no budget remaining ($${parentRemainingUsd.toFixed(2)}) — ` +
      `top up or raise its cap before sandbox turns (the mint would have asked $${requestedUsd.toFixed(2)})`,
    )
    this.name = 'ParentBudgetExhaustedError'
    this.requestedUsd = requestedUsd
    this.parentRemainingUsd = parentRemainingUsd
  }
}

export interface DeriveChildKeyBudgetInput {
  /** The configured/default ask (the product's mint budget). Must be a
   *  finite positive number. */
  readonly requestedUsd: number
  /** The parent's REMAINING budget as the platform's verify/key info
   *  reports it. `null`/`undefined`/non-finite = unknown (not reported). */
  readonly parentRemainingUsd?: number | null
  /** Minimum child budget override. Default {@link MIN_CHILD_KEY_BUDGET_USD}. */
  readonly minChildUsd?: number
}

export interface DerivedChildKeyBudget {
  /** The ask the mint should make — never above a known remaining, never
   *  below the platform minimum. */
  readonly budgetUsd: number
  /** True when the ask was lowered (or floored) because the parent holds
   *  less than the configured default. */
  readonly derivedFromParent: boolean
  /** True when the platform reports no ceiling and the configured ask stood. */
  readonly parentRemainingUnknown: boolean
}

/** Derive the delegated child-key budget from the parent's remaining budget.
 *  Throws {@link ParentBudgetExhaustedError} when the parent is exhausted,
 *  before any mint is attempted. */
export function deriveChildKeyBudgetUsd(input: DeriveChildKeyBudgetInput): DerivedChildKeyBudget {
  const minChildUsd = input.minChildUsd ?? MIN_CHILD_KEY_BUDGET_USD
  if (!Number.isFinite(input.requestedUsd) || input.requestedUsd <= 0) {
    throw new Error(
      `deriveChildKeyBudgetUsd: requestedUsd must be a finite positive USD amount (got ${input.requestedUsd})`,
    )
  }
  if (!Number.isFinite(minChildUsd) || minChildUsd <= 0) {
    throw new Error(
      `deriveChildKeyBudgetUsd: minChildUsd must be a finite positive USD amount (got ${minChildUsd})`,
    )
  }
  const ceiling = input.parentRemainingUsd
  const known = typeof ceiling === 'number' && Number.isFinite(ceiling)
  if (!known) {
    return { budgetUsd: input.requestedUsd, derivedFromParent: false, parentRemainingUnknown: true }
  }
  if (ceiling <= 0) throw new ParentBudgetExhaustedError(input.requestedUsd, ceiling)
  // Never above remaining (floored to whole cents), never below the platform
  // minimum: max(min, min(requested, floor(remaining·100)/100)).
  const budgetUsd = Math.max(minChildUsd, Math.min(input.requestedUsd, Math.floor(ceiling * 100) / 100))
  return {
    budgetUsd,
    derivedFromParent: budgetUsd < input.requestedUsd || ceiling < minChildUsd,
    parentRemainingUnknown: false,
  }
}
