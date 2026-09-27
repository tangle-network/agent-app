/**
 * Summarize rater agreement, within-item spread, and surviving-judge coverage.
 * Consumers choose the thresholds that a trustworthy result must satisfy.
 * Agreement does not measure evaluator errors against independent controls.
 * Use agent-eval/meta-eval's auditEvaluator when the consumer needs that separate evidence.
 * Spread stays within each item so differences in task quality cannot mimic rater disagreement.
 */
import { type JudgeVerdict } from '@tangle-network/agent-eval';
/** One item's raters: the per-judge verdicts {@link aggregateJudgeVerdicts}
 *  reduces, tagged with the item they scored so spread stays within-item. */
export interface TrustItem<D extends string = string> {
    /** Stable item identifier — surfaces in `perItemSpread` and `trustReasons`. */
    itemId: string;
    /** The raters' verdicts for THIS item (one per judge call). A failed judge
     *  (`perDimension: null`) is dropped before spread/IRR, never folded as 0. */
    verdicts: readonly JudgeVerdict<D>[];
}
/** Configurable agreement and coverage thresholds for {@link trustVerdicts}. */
export interface TrustThresholds {
    /** Minimum corpus inter-rater reliability (Krippendorff-style α). Default 0.2. */
    irrFloor?: number;
    /** Maximum per-item rater spread (`max − min` over a single item's surviving
     *  raters, across its dimensions). Above this the raters split ON THAT ITEM.
     *  Default 0.5. */
    spreadCeiling?: number;
    /** Minimum surviving (non-failed) raters required per item. Default 3. */
    minSurvivors?: number;
}
/** Result of the trust gate. `trustworthy` iff every check passed; `trustReasons`
 *  is empty iff `trustworthy`. */
export interface TrustVerdict {
    /** True iff IRR ≥ floor AND every item's spread ≤ ceiling AND every item has
     *  ≥ `minSurvivors` surviving raters. */
    trustworthy: boolean;
    /** One entry per FAILED check, each naming its number + the offending value.
     *  Empty iff `trustworthy`. */
    trustReasons: string[];
    /** Corpus inter-rater reliability actually measured (the check-1 value). */
    interRaterReliability: number;
    /** Per-item spread (`max − min` over surviving raters, max over dimensions),
     *  keyed by `itemId`. The check-2 input, surfaced for drill-down. */
    perItemSpread: Record<string, number>;
}
/**
 * Check an ensemble against its configured agreement and coverage thresholds. Pure: no LLM, no I/O, no clock, no random —
 * the same `items` + `thresholds` always yield the same verdict.
 *
 * Sibling to {@link aggregateJudgeVerdicts}: that reduces ONE item's raters to a
 * composite; this summarizes agreement across the supplied items.
 * A passing result does not establish evaluator accuracy or authorize a release.
 *
 * @throws if `items` is empty — an empty corpus has no measurable trust, and a
 *   silent `trustworthy: true` over zero evidence is the exact lie the gate
 *   exists to refuse.
 */
export declare function trustVerdicts<D extends string>(items: readonly TrustItem<D>[], thresholds?: TrustThresholds): TrustVerdict;
