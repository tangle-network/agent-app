---
name: measurement-validation
description: Check whether an evaluation supports an optimization or release decision through calibrated scoring, independent comparison units, and complete paired evidence.
---

# Measurement validation

Check the measurement through the product's actual evaluation path before interpreting an optimization result.
Separate exploratory evidence from evidence that satisfies a release policy.

## Establish the measurement

1. State the user outcome, target population, independent comparison unit, and smallest useful effect.
   Record the scoring revision, selection procedure, resource limits, and stopping rule before comparing candidates.
2. Run a simple baseline and independent positive and negative controls through the scorer.
   Use `auditEvaluator` from `@tangle-network/agent-eval/meta-eval` when the scorer needs an accuracy audit.
   Report false acceptances, false rejections, and missing observations against the product's requirements.
3. Check repeatability and choose enough independent units to resolve the intended effect.
   Use `powerPreflight` to guide sampling and budget decisions.
   An underpowered result can guide exploration; it cannot certify an improvement.
4. Keep final comparison cases separate from training and candidate selection.
   Register shared source units when several scenarios come from the same source.
   Additional repetitions do not create new independent units.

## Assess the result

1. Inspect raw baseline and candidate cells, judge failures, pairing, and the registered unit mapping.
   Missing or asymmetric evidence must remain visible and must block a promotion claim.
2. Use Eval's `heldOutGate` or `heldoutSignificance` for the shared promotion decision.
   Report its deciding interval, independent-unit count, eligibility, and vetoes.
   The bootstrap diagnostic may differ from the deciding interval for binary outcomes.
3. Use App's `trustVerdicts` to check rater agreement and surviving-judge coverage when an ensemble is present.
   Agreement alone does not establish accuracy against independent controls or authorize release.
4. Investigate null or surprising results before assigning a cause.
   A control intervention supports a causal explanation only when it isolates the proposed mechanism.
5. Retain actual costs, failures, exclusions, and uncertainty with the result.
   Apply the product's release policy to the deciding evidence and record what the evidence cannot establish.

## Then consider

| Condition | Skill |
|---|---|
| Scoring or case coverage cannot test the required outcome | `eval-architect` with the failed controls and missing coverage |
| Measurement supports a scoped optimization experiment | `improve-conductor` with the baseline, registered comparison, and resource limits |
