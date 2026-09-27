---
name: eval-architect
description: Build or repair evaluations that score the agent's actual deliverable through the production path, with independent controls and visible missing evidence.
---

# Eval architect

Build the measurement around the product's required outcome and actual execution path.
Reuse maintained Eval contracts and existing product checks before creating another scorer.

## Locate the deliverable

1. Inspect real runs to find the output channel: replies, validated tool calls, persisted artifacts, application state, or rendered UI.
   Score the channel that carries the required outcome.
2. Define the completion boundary for the task.
   For work that accumulates across turns, evaluate the completed artifact and retain intermediate evidence needed to explain failures.
3. Trace every consumer of the score, including completion checks, optimization selection, and release decisions.
   When the output channel changes, update every affected consumer.

## Build the checks

1. Map each requirement to observable evidence and an explicit failure condition.
   Use answer keys when available; otherwise use independently justified constraints, executable checks, or calibrated judgment.
   Keep unsupported requirements and missing evidence visible.
2. Establish a simple baseline through the same entrypoint as the candidate.
   Investigate surprising scores instead of assuming either the scorer or the agent caused them.
3. Separate training, candidate selection, and final comparison evidence where the improvement claim requires those partitions.
   Preserve scenario identities and shared source-unit mappings across baseline and candidate runs.
4. Define critical failure checks separately from aggregate quality.
   A favorable composite must not erase a failure that violates the product's requirements.
5. Preserve scorer identity, actual cost receipts, execution failures, and diagnostic artifacts.
   Change `judgeVersion` when an ensemble scorer's configuration changes.

## Prove the measurement

Run known positive and negative examples through the complete scoring path.
Perturb a real deliverable so required behavior improves or regresses, then check that the score detects each change.
Confirm that absent output and evaluator failure remain distinguishable from measured low quality.
Report case coverage, detectable failures, uncertainty, and any requirements the evaluation cannot assess.
A training gain without a final-comparison gain needs diagnosis; it does not identify the cause by itself.

## Then consider

| Condition | Skill |
|---|---|
| The evaluation path executes and needs calibration or comparison checks | `measurement-validation` with the baseline and control results |
| The validated measurement supports a candidate search | `surface-evolution` with the target surface, evidence, and resource limits |
