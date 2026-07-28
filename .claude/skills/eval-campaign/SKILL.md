---
name: eval-campaign
description: Wire product measurement and improvement to Agent Eval campaigns, official optimizers, and explicit release decisions.
---

# Wire Eval Campaigns

Use `@tangle-network/agent-app/eval-campaign` as the product-facing import.
It composes Agent Eval `0.133.0`.
Do not recreate execution, scoring, data splitting, or optimization.

## Choose The Entry Point

| Job | Use |
|---|---|
| Measure one fixed agent | `runCampaign` |
| Optimize with official GEPA | `selfImprove` with `gepaOptimizationMethod(...)` |
| Optimize with Microsoft SkillOpt | `selfImprove` with `skillOptOptimizationMethod(...)` |
| Adapt another text optimizer | `selfImprove` with `externalTextOptimizationMethod(...)` |
| Let product code generate candidates | `selfImprove` with an explicit `SurfaceProposer` |
| Compare complete methods on the same cases | `compareOptimizationMethods` |

There is no default candidate generator.
When `budget.generations` is greater than zero, pass exactly one of `method` or `proposer`.

## Supply Product Inputs

1. Define `scenarios` with stable IDs.
2. Implement `agent(surface, scenario, ctx)` against the real execution path.
3. Report paid calls through `ctx.cost`.
4. Define a `JudgeConfig`, or use `buildEnsembleJudge` for repeated independent judges.
5. Keep method-selection cases separate from final comparison cases.
6. Set a dollar limit and bounded concurrency.
7. Promote only when `gateDecision` is `ship`.

```ts
import {
  buildEnsembleJudge,
  selfImprove,
  type OptimizationMethod,
} from '@tangle-network/agent-app/eval-campaign'

async function optimize(
  method: OptimizationMethod<MyScenario, MyArtifact>,
) {
  const judge = buildEnsembleJudge<MyArtifact, MyScenario, 'accuracy'>({
    name: 'answer-quality',
    rubric: ['accuracy'],
    scoreOne: scoreOneAnswer,
  })

  return selfImprove({
    scenarios,
    selectionScenarios,
    agent: runUnderSurface,
    judge,
    baselineSurface,
    method,
    budget: {
      generations: 1,
      dollars: 10,
      maxConcurrency: 2,
    },
  })
}
```

## Reject Invalid Runs

- Reject missing or zero usage on real model calls.
- Record a failed judge as `perDimension: null`; never invent a zero.
- Require non-empty training and final comparison sets.
- Never expose final comparison cases to an optimization method.
- Inspect paired results and complete cost accounting before making a claim.

## Then consider

- Use `measurement-validation` when the metric has not separated known-good and known-bad cases.
- Use `surface-evolution` when the measurement is trusted and one production surface is ready to optimize.
