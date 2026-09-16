---
name: improve-conductor
description: Drive a requested optimization from its target and resource limits through measured candidate selection, evidence review, and the product's promotion policy.
---

# Improve conductor

Own the requested outcome, actual spend, and the decision supported by the evidence.
Distinguish building an evaluation, searching for candidates, and proving an improvement.

## Establish the work

1. Recover the target, required outcome, existing evaluation, and authorization from the user's request and product context.
   Ask only for consequential information that the available evidence cannot resolve.
2. Inspect the current baseline and the system's failure cases.
   Choose a surface change, capability change, or architecture experiment according to the observed limitation.
3. Check that the evaluation can detect the required behavior through the production entrypoint.
   If it cannot, build that measurement before making improvement claims.
   Record measurement work as measurement work, including its actual cost.
4. Set resource limits and a stopping rule for the selected experiment.
   Estimate cost from the actual execution path and retain uncertainty about additional calls, retries, and candidate evaluations.
   More spend does not guarantee a useful candidate or a conclusive result.

## Run and decide

1. Use the maintained optimization method and execution path already available to the product.
   Preserve training, selection, and final-comparison boundaries along with the registered observation units.
2. Retain candidate artifacts, scorer identity, paired raw evidence, failures, and complete attempt costs.
   Missing usage remains an explicit accounting gap.
3. Read the shared deciding statistic and the producer's actual verdict.
   Distinguish missing evidence, a measured failure, an inconclusive comparison, and a result that meets the release policy.
4. Investigate surprising gains and null results with controls that isolate the suspected mechanism.
   Use a footprint control when the claim concerns content versus added context; it is not a universal release prerequisite.
5. Promote only through the product's authorized decision path after its required checks pass.
   A promising exploratory result can justify another scoped experiment without establishing an improvement.

## Report

State what changed, the baseline comparison, deciding interval, independent-unit count, actual costs, and the verdict's reasons.
Explain whether the run stopped because it reached its registered criterion, exhausted its budget, or could not capture valid evidence.
A proposed follow-up must state which uncertainty it could resolve; extra budget alone does not promise confirmation.

## Then consider

| Condition | Skill |
|---|---|
| The product has no usable evaluation path | `eval-bootstrap` with the observed deliverable and missing checks |
| A scorer or output-channel defect prevents assessment | `eval-architect` with the failed case and execution evidence |
| Existing measurements need calibration or comparison review | `measurement-validation` with the baseline and retained results |
| The supported next experiment changes an existing surface | `surface-evolution` with the target, acceptance criteria, and resource limits |
