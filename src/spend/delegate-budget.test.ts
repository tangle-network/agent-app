import { describe, expect, it } from 'vitest'
import {
  MIN_CHILD_KEY_BUDGET_USD,
  ParentBudgetExhaustedError,
  deriveChildKeyBudgetUsd,
} from './delegate-budget'

/** The exact contract proven live against the platform (2026-10-09 bisect:
 *  parent $5 → ask $5 ✓ / $10 ✗ / $25 ✗) and lifted from hardware-agent's
 *  workspace-key derivation. Drift here is a fleet-wide mint regression. */
describe('deriveChildKeyBudgetUsd', () => {
  it('asks the configured default when the platform reports no parent budget', () => {
    for (const parentRemainingUsd of [undefined, null] as const) {
      expect(deriveChildKeyBudgetUsd({ requestedUsd: 25, parentRemainingUsd })).toEqual({
        budgetUsd: 25,
        derivedFromParent: false,
        parentRemainingUnknown: true,
      })
    }
  })

  it('treats a non-finite parent report as unknown, not as zero', () => {
    expect(deriveChildKeyBudgetUsd({ requestedUsd: 25, parentRemainingUsd: Number.NaN }).budgetUsd).toBe(25)
  })

  it("asks the parent's remaining when it holds less than the default (the killer case)", () => {
    const out = deriveChildKeyBudgetUsd({ requestedUsd: 25, parentRemainingUsd: 5 })
    expect(out.budgetUsd).toBe(5)
    expect(out.derivedFromParent).toBe(true)
    expect(out.parentRemainingUnknown).toBe(false)
  })

  it('floors a fractional remaining to whole cents (never above remaining)', () => {
    expect(deriveChildKeyBudgetUsd({ requestedUsd: 25, parentRemainingUsd: 8.37 }).budgetUsd).toBe(8.36)
  })

  it('asks the configured default when the parent holds more (never more than configured)', () => {
    const out = deriveChildKeyBudgetUsd({ requestedUsd: 25, parentRemainingUsd: 500 })
    expect(out.budgetUsd).toBe(25)
    expect(out.derivedFromParent).toBe(false)
  })

  it(`keeps the $${MIN_CHILD_KEY_BUDGET_USD} floor so tiny parents still mint a valid key`, () => {
    expect(deriveChildKeyBudgetUsd({ requestedUsd: 25, parentRemainingUsd: 0.1 }).budgetUsd).toBe(0.5)
  })

  it('refuses an exhausted parent before any mint, with both numbers on the error', () => {
    expect(() => deriveChildKeyBudgetUsd({ requestedUsd: 25, parentRemainingUsd: 0 }))
      .toThrow(ParentBudgetExhaustedError)
    try {
      deriveChildKeyBudgetUsd({ requestedUsd: 25, parentRemainingUsd: 0 })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ParentBudgetExhaustedError)
      const refusal = error as ParentBudgetExhaustedError
      expect(refusal.requestedUsd).toBe(25)
      expect(refusal.parentRemainingUsd).toBe(0)
      expect(refusal.message).toMatch(/no budget remaining.*top up/)
    }
  })

  it('refuses a malformed configured ask with both numbers named', () => {
    for (const requestedUsd of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => deriveChildKeyBudgetUsd({ requestedUsd })).toThrow(/requestedUsd must be a finite positive/)
    }
  })

  it('honors a product-supplied minimum', () => {
    expect(deriveChildKeyBudgetUsd({ requestedUsd: 25, parentRemainingUsd: 0.05, minChildUsd: 0.02 }).budgetUsd).toBe(0.05)
    // below the custom minimum, the floor applies: max(0.02, min(25, 0.01)) = 0.02
    expect(deriveChildKeyBudgetUsd({ requestedUsd: 25, parentRemainingUsd: 0.01, minChildUsd: 0.02 }).budgetUsd).toBe(0.02)
    expect(() => deriveChildKeyBudgetUsd({ requestedUsd: 25, parentRemainingUsd: 0.05, minChildUsd: 0 })).toThrow(/minChildUsd/)
  })
})
