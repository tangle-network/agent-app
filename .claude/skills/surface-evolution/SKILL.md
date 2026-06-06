---
name: surface-evolution
description: Optimize ONE evolvable surface (a prompt section / tool config) against a validated measurement, gate winners on held-out evidence plus a critical-dimension floor, and promote without offline/online drift. Use to run an Improve loop once eval-architect + measurement-validation pass.
---

# Surface Evolution — run the gated loop, promote without drift

You are a closed-loop controller for agent quality. **Sensor** = the eval (built by `eval-architect`, certified by `measurement-validation`). **Controller** = the driver that proposes surface rewrites. **Actuator** = promotion (writing the surface to the live agent). **Safety interlock** = the gate. The interlock is the entire point: it prefers *under-promotion* to Goodhart. A loop that ships every apparent gain is worthless; a loop that ships only evidence-backed gains is the product.

The engine exists in the substrate (`@tangle-network/agent-eval/contract` `selfImprove` / `runImprovementLoop`, `gepaDriver`, `defaultProductionGate`) — re-exported via `@tangle-network/agent-app/eval-campaign`. **Do not rebuild it.** This skill is how you wire and run it safely.

## Invariant (non-negotiable)

1. **Optimize exactly ONE surface that production renders identically.** The artifact you mutate offline must be the artifact the live agent loads — one source, rendered both places (e.g. an evolvable prompt section materialized from a single file into the live system prompt). If offline and online diverge, the lift is fictional the moment it ships.
2. **Gate promotion on a held-out split AND a critical-dimension floor.** Never promote a net composite gain that regresses a guarded dimension (safety, hallucination, the regulated invariant). A +10 composite that loses 30 on hallucination is a regression, not a win.
3. **Budget is a hard ceiling and cost-aware** — skip cells beyond the ceiling, never abort. The user's spend maps to generations × candidates × reps: $0.20 buys one quick generation; $50 buys a wide search with tight CIs.
4. **Never evolve a frozen surface.** The regulated invariants — human-in-the-loop, the compliance gate, auth/RBAC — are off-limits. Declare exactly what is evolvable; everything else the loop must not touch.

> Worked result (this is the skill working): a GEPA run on the legal addendum proposed a "multi-jurisdictional divergence handling" section, diagnosed from the worst *training* personas. The gate guarded `hallucination_free` (no regression) and required held-out significance. When the held-out evidence came back incomplete, it **refused to ship** — exactly right. Trust > lift.

## Judgment (figure this out per product)

- Which surface is safe to evolve (a guidance section, a tool description, a config knob) vs frozen (the invariants above)?
- How to scope budget to the gap — one generation to confirm a hunch, many to search a wide space?
- When has it converged or plateaued? If surface-tuning is exhausted and the gap is architectural, escalate — don't keep spending on a surface that's maxed.

## Self-test

- **After a promotion, the live agent renders the exact winning surface** — diff the deployed artifact against the promoted one. They must be byte-identical.
- **The held-out lift reproduces on a fresh run** — a one-shot gain is noise until it repeats.
- **The gate's rejections are honest** — a held verdict carries a stated reason ("0 valid paired runs", "regressed guarded dimension"), never a silent pass and never a lift over partial data.

## Evolves-by

Production outcomes of shipped surfaces (did the held-out lift actually hold live?) feed back into the driver's mutation priors and the gate's thresholds. A surface that lifted offline but flatlined live tells you the held-out set wasn't representative — widen it. See `skill-evolution`.
