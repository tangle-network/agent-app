---
name: measurement-validation
description: Prove a measurement is sound BEFORE spending money optimizing against it. The gate that decides whether an Improve run is allowed to start, and whether its result is allowed to be believed. Refuse metrics whose noise exceeds the effect, that have no held-out split, or whose evidence is incomplete.
---

# Measurement Validation — earn the right to optimize

Optimization is only as trustworthy as the measurement under it. This skill is the gate on both ends: **before** a paid run (is this metric allowed to be optimized?) and **after** (is this result allowed to be believed?). It is the difference between an Improve button that is a product and one that is a slot machine.

Held by both the orchestrator (`improve-conductor`) and the builder (`eval-architect`). It is the shared honesty contract.

## Invariant (non-negotiable)

1. **Refuse to optimize if CV(metric) > the target delta.** If the run-to-run noise is bigger than the effect you're paying to move, the metric *cannot* validate the change — raise reps or fix the metric first. Do not tune against noise.
2. **Refuse to report a lift over INCOMPLETE or UNPAIRED evidence.** Every held-out scenario must have a non-errored cell on *both* the baseline and the candidate side. Below the paired-n floor (≥3), the run is **invalid**, not a verdict. A lift computed over survivors is worse than no number.
3. **Every metric ties to a product-value claim** — "if this number moves, *this* user-visible outcome moves with it." No claim → it's a proxy → don't optimize it.
4. **Below the data threshold of real outcomes, refuse to optimize** — state N and say why. You cannot improve what you have not yet observed enough of.

> Worked failures (this is why the skill exists):
> - **Noise read as signal:** ~6 optimization rounds were burned chasing ±0.15 run-to-run swings as if they were real. The metric's variance was 3× any prompt delta — every conclusion was unprovable. The bug was the *measurement*, not the model.
> - **A lift that was a lie:** a GEPA run reported `heldOutLift = +47`. Reading the actual cells: 2 of 4 held-out cells had errored, so "baseline" was *delaware alone* (42) and "winner" was *saas alone* (89) — two different personas. The +47 was differencing unlike cells. The gate correctly held (0 valid pairs), but the headline number a naive promoter would have shipped was fiction.

## Judgment (figure this out per metric)

- How many reps establish variance for *this* metric? (Noisy targets need 5+, converged-artifact metrics fewer.)
- Is an observed "noisy" result model variance, or a measurement smell? **Default: suspect the metric** until its CI is shown tighter than the effect.
- Where might this metric diverge from real value (the Goodhart risk specific to this product)?

## Self-test

- Report **mean ± 95% CI over K converged rollouts.** Show CI < target delta *before* greenlighting spend. If you can't, you haven't earned the right to optimize yet.
- Confirm the held-out split is disjoint from training and large enough that the paired-n floor survives an errored cell.
- **Verify against ground truth, never the summary.** Read the actual cells / artifacts, not the provenance headline. (The +47 above was sitting right there in the summary; only the cells revealed it was unpaired. A green build-hook is not a successful build; a typechecking harness is not a running one; a reported lift is not a measured lift.)

## Evolves-by

Track promotions that passed validation but regressed in production → that's a missed variance source or an unguarded dimension; strengthen the preflight. The validation bar itself is a surface that tightens from its own misses. See `skill-evolution`.
