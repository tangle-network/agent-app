/**
 * trustVerdicts is the after-gate: it decides whether an ensemble's scores are
 * believable. These tests pin the three checks and — most importantly — the
 * spread semantics: agreeing raters across genuinely DIFFERENT items must stay
 * trustworthy (no pooled spread), while raters splitting on ONE item must trip
 * check (2) and name that item.
 */

import { describe, expect, it } from 'vitest'

import { trustVerdicts, type TrustItem } from './trust-gate'

type Dim = 'accuracy' | 'tone'

/** One item: N raters, each given the same per-dimension scores. */
function agreeingItem(itemId: string, score: number, raters = 3): TrustItem<Dim> {
  return {
    itemId,
    verdicts: Array.from({ length: raters }, (_, i) => ({
      model: `m${i}`,
      perDimension: { accuracy: score, tone: score },
    })),
  }
}

describe('trustVerdicts', () => {
  it('agreeing raters over wide item-to-item differences → trustworthy, zero spread flags', () => {
    // Items span the full range (0.05 … 0.95); raters AGREE within each item.
    // A pooled spread would be ~0.9 and falsely trip — within-item spread is 0.
    const items = [
      agreeingItem('easy', 0.95),
      agreeingItem('medium', 0.5),
      agreeingItem('hard', 0.05),
    ]
    const v = trustVerdicts(items)
    expect(v.trustworthy).toBe(true)
    expect(v.trustReasons).toEqual([])
    expect(v.perItemSpread).toEqual({ easy: 0, medium: 0, hard: 0 })
    expect(v.interRaterReliability).toBeGreaterThanOrEqual(0.2)
  })

  it('raters split on ONE item → (2) names that item, others stay clean', () => {
    const items = [
      agreeingItem('clean-a', 0.9),
      {
        itemId: 'contested',
        verdicts: [
          { model: 'm0', perDimension: { accuracy: 0.1, tone: 0.9 } },
          { model: 'm1', perDimension: { accuracy: 0.9, tone: 0.9 } }, // 0.8 spread on accuracy
          { model: 'm2', perDimension: { accuracy: 0.9, tone: 0.9 } },
        ],
      } satisfies TrustItem<Dim>,
      agreeingItem('clean-b', 0.4),
    ]
    const v = trustVerdicts(items)
    expect(v.trustworthy).toBe(false)
    expect(v.perItemSpread.contested).toBeCloseTo(0.8, 5)
    expect(v.perItemSpread['clean-a']).toBe(0)
    expect(v.perItemSpread['clean-b']).toBe(0)
    const spreadReasons = v.trustReasons.filter((r) => r.startsWith('(2)'))
    expect(spreadReasons).toHaveLength(1)
    expect(spreadReasons[0]).toContain('contested')
    expect(spreadReasons[0]).toContain('0.8')
    expect(spreadReasons[0]).toContain('raters split')
  })

  it('low corpus IRR → (1) with the measured value and the floor', () => {
    // Raters disagree on every item with NO consistent item-to-item structure:
    // observed within-item disagreement ≈ pooled expected → α near 0.
    const items: TrustItem<Dim>[] = [
      {
        itemId: 'i0',
        verdicts: [
          { model: 'm0', perDimension: { accuracy: 0.0, tone: 1.0 } },
          { model: 'm1', perDimension: { accuracy: 1.0, tone: 0.0 } },
          { model: 'm2', perDimension: { accuracy: 0.5, tone: 0.5 } },
        ],
      },
      {
        itemId: 'i1',
        verdicts: [
          { model: 'm0', perDimension: { accuracy: 1.0, tone: 0.0 } },
          { model: 'm1', perDimension: { accuracy: 0.0, tone: 1.0 } },
          { model: 'm2', perDimension: { accuracy: 0.5, tone: 0.5 } },
        ],
      },
    ]
    // Loosen spread so check (2) does not also fire — isolate check (1).
    const v = trustVerdicts(items, { spreadCeiling: 1 })
    expect(v.trustworthy).toBe(false)
    expect(v.interRaterReliability).toBeLessThan(0.2)
    const irrReasons = v.trustReasons.filter((r) => r.startsWith('(1)'))
    expect(irrReasons).toHaveLength(1)
    expect(irrReasons[0]).toContain('< 0.2')
    expect(irrReasons[0]).toContain(String(Math.round(v.interRaterReliability * 100) / 100))
  })

  it('too few surviving raters → (3) names the item and its count', () => {
    const items = [agreeingItem('thin', 0.8, 2)] // 2 raters < default 3
    const v = trustVerdicts(items)
    expect(v.trustworthy).toBe(false)
    const survivorReasons = v.trustReasons.filter((r) => r.startsWith('(3)'))
    expect(survivorReasons).toHaveLength(1)
    expect(survivorReasons[0]).toContain('thin')
    expect(survivorReasons[0]).toContain('2 surviving raters < 3')
  })

  it('a failed judge is dropped (not a zero) before spread and survivor count', () => {
    const items: TrustItem<Dim>[] = [
      {
        itemId: 'one-down',
        verdicts: [
          { model: 'm0', perDimension: { accuracy: 0.8, tone: 0.8 } },
          { model: 'm1', perDimension: { accuracy: 0.8, tone: 0.8 } },
          { model: 'm2', perDimension: { accuracy: 0.8, tone: 0.8 } },
          { model: 'm3', perDimension: null, rationale: 'judge down' }, // dropped, NOT 0
        ],
      },
    ]
    const v = trustVerdicts(items)
    // If the failed judge were folded as a 0, spread would be 0.8 and (2) fires.
    expect(v.perItemSpread['one-down']).toBe(0)
    expect(v.trustworthy).toBe(true)
    expect(v.trustReasons).toEqual([])
  })

  it('all thresholds are overridable', () => {
    const items = [
      {
        itemId: 'borderline',
        verdicts: [
          { model: 'm0', perDimension: { accuracy: 0.4, tone: 0.4 } },
          { model: 'm1', perDimension: { accuracy: 0.7, tone: 0.7 } }, // 0.3 spread
        ],
      } satisfies TrustItem<Dim>,
    ]
    // Defaults would fail: spread 0.3 ≤ 0.5 ok, but only 2 raters < 3 → (3).
    const strict = trustVerdicts(items)
    expect(strict.trustworthy).toBe(false)

    // Relax the survivor floor to 2 and tighten spread below 0.3 → only (2) fires.
    const relaxed = trustVerdicts(items, { minSurvivors: 2, spreadCeiling: 0.2, irrFloor: -1 })
    expect(relaxed.trustReasons.some((r) => r.startsWith('(3)'))).toBe(false)
    expect(relaxed.trustReasons.some((r) => r.startsWith('(2)'))).toBe(true)

    // Loosen everything → trustworthy.
    const loose = trustVerdicts(items, { minSurvivors: 2, spreadCeiling: 1, irrFloor: -1 })
    expect(loose.trustworthy).toBe(true)
  })

  it('throws on an empty corpus (no silent trust over zero evidence)', () => {
    expect(() => trustVerdicts([])).toThrow(/items is empty/)
  })
})
