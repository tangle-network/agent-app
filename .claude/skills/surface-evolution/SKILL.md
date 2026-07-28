---
name: surface-evolution
description: Optimize one production agent surface with Agent Eval methods, separate data, bounded spend, and measured promotion.
---

# Evolve One Surface

Optimize one surface that production loads exactly as measured.
Keep security, approval, authorization, and compliance rules outside the editable surface.

## Run

1. Identify the exact source file or data object that production loads.
2. Establish training, method-selection, and final comparison cases with no overlap.
3. Choose one search path:
   - Use `gepaOptimizationMethod(...)` for official GEPA.
   - Use `skillOptOptimizationMethod(...)` for official SkillOpt.
   - Use `externalTextOptimizationMethod(...)` for another maintained optimizer.
   - Use `SurfaceProposer` only when product or Runtime code owns candidate generation.
4. Pass the chosen `method` or `proposer` to `selfImprove`.
5. Set explicit dollars, concurrency, and repetitions.
6. Guard critical dimensions in the release policy.
7. Pass `neutralize` when added prompt size could create a decorative lift.
8. Promote only the exact returned winner when `gateDecision` is `ship`.

## Required Checks

- Prove the metric rejects a known-bad candidate before spending on search.
- Prove each compared cell executed and reported usage.
- Require paired final-case evidence.
- Reject a winner that regresses any protected dimension.
- After promotion, compare the live bytes with the selected surface.
- Repeat the final comparison on fresh cases before claiming a durable gain.

Stop when added candidates no longer improve selection results within the budget.
If failures require new tools, data, or execution behavior, change the architecture instead of continuing prompt search.

## Then consider

- Use `measurement-validation` when the metric or final-case split is not yet trustworthy.
- Use `skill-evolution` when repeated runs expose a durable improvement to this operating procedure.
