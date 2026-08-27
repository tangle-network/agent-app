/**
 * Eval-campaign — the app-shell's curated surface for a product's
 * self-improvement loop, NOT a reimplementation.
 *
 * The loop ENGINE lives in `@tangle-network/agent-eval` (a peer dependency):
 * `selfImprove` already owns the whole cycle — train/holdout split, the GEPA
 * proposer, the held-out production gate, durable provenance + hosted ingest, and
 * every default. A product should NOT hand-roll `runImprovementLoop` +
 * `emitLoopProvenance` around it (that is the boilerplate this surface exists to
 * delete). It should call `selfImprove` with three things it actually owns:
 * scenarios, an `agent` dispatch, and a `judge`.
 *
 * This module adds the one piece `selfImprove` does not own and which every
 * multi-model product re-hand-rolls — the ensemble judge:
 *
 *   {@link buildEnsembleJudge} — turn a per-rubric `scoreOne` into a
 *   `JudgeConfig` that fans out N uncorrelated judge calls and reduces them via
 *   the substrate's `aggregateJudgeVerdicts` (survivor-mean, inter-rater spread,
 *   fail-loud on all-failed). A product writes its rubric + one judge call; the
 *   fan-out, partial-failure handling, and composite are the scaffold's.
 *
 * Everything else is a curated re-export so a product has ONE eval import:
 * `selfImprove` + the gates + the proposers + the types. See
 * `.claude/skills/eval-campaign/SKILL.md` for the wiring contract.
 */

import {
  aggregateJudgeVerdicts,
  type JudgeVerdict,
} from '@tangle-network/agent-eval'
import type {
  JudgeConfig,
  JudgeScore,
  Scenario,
} from '@tangle-network/agent-eval/campaign'

/** Config for {@link buildEnsembleJudge}. `D` = the rubric's dimension union. */
export interface EnsembleJudgeConfig<TArtifact, TScenario extends Scenario, D extends string> {
  /** Judge name — appears in traces and scorecards. */
  name: string
  /** Stable-ordered rubric dimensions. Drives the `JudgeDimension` list AND the
   *  reducer keys, so a judge that omits a dimension scores it 0 (never silently
   *  dropped). */
  rubric: readonly D[]
  /**
   * Score ONE artifact on the rubric → a raw per-dimension verdict. Called
   * `judgeReps` times per artifact; vary the model by `rep` for an uncorrelated
   * ensemble (judges that share a base model share its bias). Return
   * `{ model, perDimension: null }` to record a judge failure WITHOUT killing
   * the ensemble; throw only on an unrecoverable error (the whole rep is then
   * treated as a failed judge).
   */
  scoreOne: (input: {
    artifact: TArtifact
    scenario: TScenario
    signal: AbortSignal
    rep: number
  }) => Promise<JudgeVerdict<D>>
  /** Independent judge calls per artifact, reduced by `aggregateJudgeVerdicts`.
   *  Default 1. Raise (with model variety in `scoreOne`) for inter-rater bands. */
  judgeReps?: number
  /** Per-dimension composite weights. Default: uniform over `rubric`. A partial
   *  map selects-and-weights exactly the named dimensions. */
  weights?: Partial<Record<D, number>>
  /** Optional human-readable dimension descriptions. Default: the key itself. */
  describe?: (dim: D) => string
}

/**
 * Build a `JudgeConfig` whose `score()` fans out `judgeReps` independent
 * `scoreOne` calls and reduces them with the substrate's
 * `aggregateJudgeVerdicts`. A single judge call failing does NOT fail the cell
 * (it is recorded and dropped); only ALL judges failing throws — which the
 * campaign records as a failed cell, never a silent zero.
 *
 * Pass the result straight to `selfImprove({ judge })` (or `runCampaign`).
 */
export function buildEnsembleJudge<TArtifact, TScenario extends Scenario, D extends string>(
  cfg: EnsembleJudgeConfig<TArtifact, TScenario, D>,
): JudgeConfig<TArtifact, TScenario> {
  const reps = cfg.judgeReps ?? 1
  if (reps < 1) {
    throw new Error(`buildEnsembleJudge: judgeReps must be >= 1 (got ${reps})`)
  }
  if (cfg.rubric.length === 0) {
    throw new Error('buildEnsembleJudge: rubric is empty')
  }
  return {
    name: cfg.name,
    dimensions: cfg.rubric.map((key) => ({ key, description: cfg.describe?.(key) ?? key })),
    async score({ artifact, scenario, signal }): Promise<JudgeScore> {
      const settled = await Promise.allSettled(
        Array.from({ length: reps }, (_, rep) => cfg.scoreOne({ artifact, scenario, signal, rep })),
      )
      const verdicts: JudgeVerdict<D>[] = settled.map((r, rep) =>
        r.status === 'fulfilled'
          ? r.value
          : { model: `${cfg.name}-rep${rep}`, perDimension: null, rationale: String(r.reason) },
      )
      // Throws iff EVERY rep failed → the campaign records a failed cell.
      const agg = aggregateJudgeVerdicts(verdicts, cfg.rubric, cfg.weights)
      return { composite: agg.composite, dimensions: agg.perDimension, notes: agg.rationale }
    },
  }
}

// ── Trust gate — the after-gate ("is this result allowed to be believed") ────
// One level up from `aggregateJudgeVerdicts`: it audits the raters ACROSS items
// and reports whether the composites are believable before a lift is reported.
export {
  trustVerdicts,
  type TrustItem,
  type TrustThresholds,
  type TrustVerdict,
} from './trust-gate'

// ── Curated re-exports — the one eval import for a product loop ──────────────
// The loop engine + gates + drivers + the ensemble reducer, so a product wires
// its self-improvement loop from a single module instead of reaching across
// three agent-eval subpaths. All DOWNWARD imports (agent-app consumes the
// substrate); the layering rule is preserved.

export { aggregateJudgeVerdicts } from '@tangle-network/agent-eval'
export type {
  EnsembleAggregate,
  JudgeVerdict,
  RunRecord,
} from '@tangle-network/agent-eval'
export {
  defaultProductionGate,
  evolutionaryProposer,
  gepaProposer,
  paretoSignificanceGate,
  runCampaign,
} from '@tangle-network/agent-eval/campaign'
export type {
  CampaignResult,
  DispatchContext,
  Gate,
  JudgeConfig,
  JudgeDimension,
  JudgeScore,
  LabeledScenarioStore,
  MutableSurface,
  Mutator,
  Scenario,
  SurfaceProposer,
} from '@tangle-network/agent-eval/campaign'
export { selfImprove } from '@tangle-network/agent-eval/contract'
export type {
  SelfImproveBudget,
  SelfImproveOptions,
  SelfImproveResult,
} from '@tangle-network/agent-eval/contract'
