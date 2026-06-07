/**
 * Trust gate — decides whether an ensemble's scores are allowed to be BELIEVED,
 * one level up from {@link aggregateJudgeVerdicts} (which only reduces ONE
 * artifact's raters to a composite). A composite is a number; this is the check
 * that the number means anything. It is the code "Enforced by" for the
 * measurement-validation skill's after-gate ("is this result allowed to be
 * believed").
 *
 * Three checks, each fail-loud and named in `trustReasons`:
 *   (1) inter-rater reliability over the corpus ≥ `irrFloor` — raters that
 *       disagree no better than chance carry no signal to optimize against.
 *   (2) per-item rater spread ≤ `spreadCeiling` — for EACH item, raters must
 *       converge on THAT item.
 *   (3) surviving raters per item ≥ `minSurvivors` — a mean over one or two
 *       raters is an anecdote, not an ensemble.
 *
 * CRITICAL metric semantics — per-item spread is rater disagreement about the
 * SAME item: `max(score) − min(score)` across the raters that scored THAT item
 * (max over its dimensions), never pooled across different items or across the
 * baseline/candidate sides. Pooling reads a genuine quality gap BETWEEN items as
 * "the raters split" and so trips the gate exactly when the finding is largest —
 * the failure mode the after-gate exists to prevent. The corpus IRR (check 1)
 * leans on the substrate's `interRaterReliability`, whose expected-disagreement
 * denominator already pools across items, so genuine item-to-item variation
 * RAISES reliability rather than lowering it.
 */

import {
  interRaterReliability,
  type JudgeScore,
  type JudgeVerdict,
} from '@tangle-network/agent-eval'

/** One item's raters: the per-judge verdicts {@link aggregateJudgeVerdicts}
 *  reduces, tagged with the item they scored so spread stays within-item. */
export interface TrustItem<D extends string = string> {
  /** Stable item identifier — surfaces in `perItemSpread` and `trustReasons`. */
  itemId: string
  /** The raters' verdicts for THIS item (one per judge call). A failed judge
   *  (`perDimension: null`) is dropped before spread/IRR, never folded as 0. */
  verdicts: readonly JudgeVerdict<D>[]
}

/** Thresholds for {@link trustVerdicts}. All overridable; defaults are the
 *  conservative after-gate bar. */
export interface TrustThresholds {
  /** Minimum corpus inter-rater reliability (Krippendorff-style α). Below this
   *  the raters agree no better than chance. Default 0.2. */
  irrFloor?: number
  /** Maximum per-item rater spread (`max − min` over a single item's surviving
   *  raters, across its dimensions). Above this the raters split ON THAT ITEM.
   *  Default 0.5. */
  spreadCeiling?: number
  /** Minimum surviving (non-failed) raters required per item. Default 3. */
  minSurvivors?: number
}

/** Result of the trust gate. `trustworthy` iff every check passed; `trustReasons`
 *  is empty iff `trustworthy`. */
export interface TrustVerdict {
  /** True iff IRR ≥ floor AND every item's spread ≤ ceiling AND every item has
   *  ≥ `minSurvivors` surviving raters. */
  trustworthy: boolean
  /** One entry per FAILED check, each naming its number + the offending value.
   *  Empty iff `trustworthy`. */
  trustReasons: string[]
  /** Corpus inter-rater reliability actually measured (the check-1 value). */
  interRaterReliability: number
  /** Per-item spread (`max − min` over surviving raters, max over dimensions),
   *  keyed by `itemId`. The check-2 input, surfaced for drill-down. */
  perItemSpread: Record<string, number>
}

const DEFAULT_IRR_FLOOR = 0.2
const DEFAULT_SPREAD_CEILING = 0.5
const DEFAULT_MIN_SURVIVORS = 3

/** Surviving (non-failed) verdicts for an item — those with a real
 *  `perDimension` map. A failed judge carries no scores and is excluded from
 *  every statistic (it is NOT a zero rater). */
function survivors<D extends string>(item: TrustItem<D>): JudgeVerdict<D>[] {
  return item.verdicts.filter((v) => v.perDimension !== null)
}

/**
 * Within-item rater spread: for each dimension, `max − min` across the item's
 * surviving raters; the item's spread is the max over its dimensions (the worst
 * dimension the raters split on). Pooled ONLY within this one item — never
 * across items — so a quality gap between items cannot inflate it.
 */
function itemSpread<D extends string>(survivorVerdicts: JudgeVerdict<D>[]): number {
  if (survivorVerdicts.length < 2) return 0
  const dims = new Set<string>()
  for (const v of survivorVerdicts) {
    for (const d of Object.keys(v.perDimension as Record<string, number>)) dims.add(d)
  }
  let worst = 0
  for (const d of dims) {
    let min = Infinity
    let max = -Infinity
    for (const v of survivorVerdicts) {
      const score = (v.perDimension as Record<string, number>)[d]
      if (score === undefined) continue
      if (score < min) min = score
      if (score > max) max = score
    }
    if (max > -Infinity && max - min > worst) worst = max - min
  }
  return worst
}

/**
 * Decide whether an ensemble's per-item verdicts are trustworthy enough to
 * believe a lift computed from them. Pure: no LLM, no I/O, no clock, no random —
 * the same `items` + `thresholds` always yield the same verdict.
 *
 * Sibling to {@link aggregateJudgeVerdicts}: that reduces ONE item's raters to a
 * composite; this audits the raters ACROSS items and reports whether the
 * composites are believable. Run it on the corpus of held-out items before
 * reporting any lift over their scores.
 *
 * @throws if `items` is empty — an empty corpus has no measurable trust, and a
 *   silent `trustworthy: true` over zero evidence is the exact lie the gate
 *   exists to refuse.
 */
export function trustVerdicts<D extends string>(
  items: readonly TrustItem<D>[],
  thresholds: TrustThresholds = {},
): TrustVerdict {
  if (items.length === 0) {
    throw new Error('trustVerdicts: items is empty — no evidence to trust')
  }
  const irrFloor = thresholds.irrFloor ?? DEFAULT_IRR_FLOOR
  const spreadCeiling = thresholds.spreadCeiling ?? DEFAULT_SPREAD_CEILING
  const minSurvivors = thresholds.minSurvivors ?? DEFAULT_MIN_SURVIVORS

  // Rater-major JudgeScore series for the substrate's IRR. Each item's surviving
  // raters are assigned a stable column index so the same rater across items
  // lines up; per (item, dimension) one JudgeScore per rater, in item-then-
  // dimension order — the layout interRaterReliability chunks back into items.
  const maxRaters = items.reduce((m, it) => Math.max(m, survivors(it).length), 0)
  const raterSeries: JudgeScore[][] = Array.from({ length: maxRaters }, () => [])
  const perItemSpread: Record<string, number> = {}
  const splitItems: Array<{ itemId: string; spread: number }> = []
  const starvedItems: Array<{ itemId: string; n: number }> = []

  for (const item of items) {
    const surv = survivors(item)
    if (surv.length < minSurvivors) starvedItems.push({ itemId: item.itemId, n: surv.length })

    const spread = itemSpread(surv)
    perItemSpread[item.itemId] = spread
    if (spread > spreadCeiling) splitItems.push({ itemId: item.itemId, spread })

    if (surv.length >= 2) {
      const dims = Array.from(
        new Set(surv.flatMap((v) => Object.keys(v.perDimension as Record<string, number>))),
      ).sort()
      surv.forEach((v, raterIdx) => {
        // raterIdx < surv.length ≤ maxRaters = raterSeries.length, so the column
        // always exists; the ??= keeps the access provably defined for the type.
        const column = (raterSeries[raterIdx] ??= [])
        const pd = v.perDimension as Record<string, number>
        for (const d of dims) {
          const score = pd[d]
          if (score === undefined) continue
          column.push({
            judgeName: v.model,
            dimension: `${item.itemId}::${d}`,
            score,
            reasoning: v.rationale ?? '',
          })
        }
      })
    }
  }

  const irr = interRaterReliability(raterSeries)

  const trustReasons: string[] = []
  if (irr < irrFloor) {
    trustReasons.push(`(1) IRR ${round(irr)} < ${irrFloor}`)
  }
  for (const { itemId, spread } of splitItems) {
    trustReasons.push(`(2) item ${itemId} spread ${round(spread)} > ${spreadCeiling} — raters split`)
  }
  for (const { itemId, n } of starvedItems) {
    trustReasons.push(`(3) item ${itemId}: ${n} surviving raters < ${minSurvivors}`)
  }

  return {
    trustworthy: trustReasons.length === 0,
    trustReasons,
    interRaterReliability: irr,
    perItemSpread,
  }
}

/** Round to 2 decimals for stable, readable reason strings. */
function round(n: number): number {
  return Math.round(n * 100) / 100
}
