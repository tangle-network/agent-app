---
name: eval-campaign
description: Wire a product agent's self-improvement loop (measure → optimize → gate → ship) onto the shared @tangle-network/agent-app/eval-campaign scaffold. Use when adding or refactoring any product agent's eval/ loop.
---

# Wiring a product onto the eval-campaign scaffold

You are integrating a product agent's self-improvement loop. The loop **engine already exists** in the substrate — do not rebuild it. Your job is to supply the three things only the product knows, and call one function.

## Mental model (read first)

`selfImprove` (from `@tangle-network/agent-eval/contract`, re-exported here) owns the entire cycle:

- the **train/holdout split** from a flat `scenarios` array,
- the **proposer** (default `gepaProposer` from your `mutationPrimitives`),
- the **held-out production gate** (default `defaultProductionGate`, `deltaThreshold` 0.05),
- **durable provenance** + optional hosted ingest,
- every budget/seed/storage default.

A product brings exactly three things:

1. **`scenarios`** — your corpus (personas / cases / tasks) in the substrate `Scenario` shape.
2. **`agent`** — `(surface, scenario, ctx) => artifact`: run your agent under the current surface (a system-prompt addendum the loop optimizes) and return the artifact your judge scores. Report real cost via `ctx.cost.observe(...)` so the backend-integrity guard sees a real run.
3. **`judge`** — score an artifact on your rubric. Use `buildEnsembleJudge` (below) for a multi-model ensemble, or hand-write a `JudgeConfig` for a bespoke composite.

Everything else is a default you override only when you have a reason.

## The one import

```ts
import {
  selfImprove,
  buildEnsembleJudge,
  type SelfImproveOptions,
  type JudgeVerdict,
} from '@tangle-network/agent-app/eval-campaign'
```

> Requires `@tangle-network/agent-eval >= 0.100.0` (peer; current published is 0.107.0). The scaffold composes the substrate downward; never import a product package from agent-eval (layering rule).

## Minimal wiring (copy, then fill the three blanks)

```ts
const RUBRIC = ['accuracy', 'grounding', 'tone'] as const
type Dim = (typeof RUBRIC)[number]

const judge = buildEnsembleJudge<MyArtifact, MyScenario, Dim>({
  name: 'my-product',
  rubric: RUBRIC,
  judgeReps: 3,                         // 3 uncorrelated judges → inter-rater bands
  async scoreOne({ artifact, scenario, rep }) {
    const model = JUDGE_MODELS[rep % JUDGE_MODELS.length]   // vary the model per rep
    try {
      const v = await callMyJudge(model, artifact, scenario) // → { accuracy, grounding, tone }
      return { model, perDimension: v, rationale: v.note, costUsd: v.cost }
    } catch (err) {
      return { model, perDimension: null, rationale: String(err) } // failure ≠ zero
    }
  },
})

const result = await selfImprove<MyScenario, MyArtifact>({
  scenarios: loadMyScenarios(),         // YOU own
  agent: dispatchUnderSurface,          // YOU own — (surface, scenario, ctx) => artifact
  judge,                                // built above
  baselineSurface: '',                  // the addendum the loop optimizes (start empty)
  mutationPrimitives: MY_DIRECTIVES,    // the optimization levers (default proposer mutates toward these)
  runDir: process.env.MY_RUN_DIR,       // a real path → durable provenance; omit → in-memory
  // budget / model / gate / hostedTenant all default — override only when needed
})

if (result.gate.decision === 'ship') await ship(result.winnerSurface)
```

## `buildEnsembleJudge` contract

- `scoreOne` is called `judgeReps` times per artifact; **vary the model by `rep`** so the ensemble is uncorrelated (judges sharing a base model share its bias).
- Return `{ model, perDimension: null }` to record a judge failure **without** killing the ensemble — the reducer means over survivors.
- The reducer (`aggregateJudgeVerdicts`) **throws only if every rep failed** → the campaign records a failed cell, never a silent zero.
- `weights` (partial) selects-and-weights named dimensions; default is uniform.

## Config reference (all `SelfImproveOptions`, all optional unless noted)

| Field | Default | When to set |
|---|---|---|
| `scenarios` | — (required) | your corpus |
| `agent` | — (required) | your dispatch under a surface |
| `judge` | — (required) | `buildEnsembleJudge` or a `JudgeConfig` |
| `baselineSurface` | — (required) | the surface the loop optimizes; start `''` |
| `mutationPrimitives` | gepaProposer's own | your optimization levers (additive directives) |
| `proposer` | `gepaProposer` | pass `evolutionaryProposer({ mutator })` for blind addendum rotation |
| `gate` | `defaultProductionGate` (Δ 0.05) | `paretoSignificanceGate` for multi-objective; tune `deltaThreshold` for your rubric scale. To prove a held-out lift is real CONTENT and not just added prompt/mount FOOTPRINT, compose `neutralizationGate` (agent-eval >= 0.107.0, from `@tangle-network/agent-eval/campaign`) — a footprint-matched placebo arm. It needs `ctx.neutralizedJudgeScores` from `runImprovementLoop({ neutralize })`; `selfImprove`/this scaffold do not surface that option yet, so wire it at the `runImprovementLoop` level or re-export it in the scaffold first. |
| `budget` | 3 gens × pop 2, 0.25 holdout | `budget.reps` (replicates → tighter CIs), `budget.promoteTopK`, `budget.holdoutScenarios` (explicit split), `budget.dollars` (cost cap) |
| `expectUsage` | **`'assert'`** | the fail-loud backend-integrity guard. Leave at `'assert'` for real runs (a stub cell throws); set `'off'` ONLY for a deterministic offline/replay run |
| `labeledStore` | off | capture every artifact + judge score (the dataset you ship + few-shot corpus); set `captureSource` (default `'eval-run'`) |
| `analyzeGeneration` | — | the per-generation findings producer (EYES→HANDS) — plug a trace-analyst / HALO to refresh `ctx.findings` each round |
| `runDir` | `mem://…` (non-durable) | a real path to persist provenance + spans |
| `hostedTenant` | off | ship eval-run events to a hosted orchestrator |
| `collectWorkerRecords` | — | return the per-call `RunRecord`s your agent accumulated → real backend-integrity verdict |
| `onProgress` | — | stream baseline/generation/gate events to a UI |

## Fail-loud contract (do not break)

- In `agent`, report real cost via `ctx.cost.observe(costUsd, label)` + `ctx.cost.observeTokens(...)`. A dispatch that reports `{0,0}` trips `expectUsage` — that is the honest "ran against a stub" signal; never paper over it.
- A judge failure is `perDimension: null`, never a fabricated zero.
- Train and holdout must both be non-empty (`selfImprove` derives the split; supply enough scenarios).

## Anti-patterns (these are what this scaffold deletes)

- ❌ Hand-rolling `runImprovementLoop({...})` + `emitLoopProvenance({...})` + a train/holdout split. That is ~100 lines of identical boilerplate per product. Call `selfImprove`.
- ❌ A per-product copy of the judge-ensemble reducer (survivor-mean / disagreement / cost-sum). Use `buildEnsembleJudge` → `aggregateJudgeVerdicts`.
- ❌ `import type` from a product package inside the scaffold or substrate (upward dependency — forbidden).

## Where it lives in the product

One file: `eval/self-improve.ts`. It exports `runMyEval` (measure: `selfImprove` with `budget.generations = 0`, or `runCampaign`) and `runMySelfImprovement` (optimize: the wiring above). The product's harness/CLI calls these; nothing else duplicates the loop.
