---
name: skill-evolution
description: How every skill in the Improve family stays agentic and general instead of rotting into a brittle rulebook. A skill is a measured hypothesis — a few human-owned invariants plus a wide loop-owned judgment surface that improves from outcome data via its own meta-eval. This is the recursion that lets the agent builder learn to build improvable agents.
---

# Skill Evolution — the skill is a surface, too

A skill written as a fixed checklist is brittle: it can't handle the product nobody anticipated, and it goes stale silently. A skill written as vibes is unaccountable. The resolution is to give every skill the *same* structure the Improve loop optimizes — a small frozen core and a wide evolvable surface — and then point the loop at the skill itself.

This is the meta-skill. It governs `eval-architect`, `measurement-validation`, `surface-evolution`, and `improve-conductor`, and it is what makes them general rather than legal-specific (or any-product-specific).

## The 4-part contract (every skill in this family follows it)

- **Invariant** — the 1–2 laws that, if violated, turn the loop into a slot machine. **Human-owned. Frozen.** Few. ("Gate on held-out." "Score the real deliverable." "Fail loud on incomplete evidence." "Never promote a regression on a guarded dimension.")
- **Judgment** — what the agent figures out for *this* product. **Loop-owned. Wide.** This is the agentic surface — the place the agent is *supposed* to think, not follow steps.
- **Self-test** — a checkable signal the agent actually ran to verify it did the work right (the mutation test, CI < delta, diff-the-deployed-surface). Not "I followed the procedure" — a *result*.
- **Evolves-by** — the outcome data that updates the *judgment* surface. Never the invariants.

**The split is the answer to "how do you keep it agentic and not a dumb rulebook":** few invariants hold the line; judgment is broad and loop-owned; outcomes are measured; the judgment surface self-revises. The agent stays free to solve the novel case — it just cannot violate the handful of laws that make optimization mean anything.

## The recursion

Each skill's *judgment* surface is itself an evolvable surface, optimized by the **same loop the skill describes**, with a verifiable reward:

> *Did following this skill produce an eval that yielded real held-out lift, with no critical-dimension regression?*

Above a data threshold of real runs, the skill proposes revisions to its own judgment — gated identically (held-out, critical-dimension floor, paired-n ≥ floor, and a footprint-matched placebo — the neutralization gate — that proves the lift came from content, not from added prompt/mount footprint). **Invariants are the frozen surface; judgment is the evolvable surface.** A skill improving itself is just `surface-evolution` pointed inward.

## The north-star: the agent builder, closed-loop

The agent builder builds agents *and* the evals that improve them. Its success is **not** "wrote an eval file." It is the verifiable reward above, applied to the agent it just built:

> *The eval the builder produced yields real held-out lift on the agent the builder built — no Goodhart regression.*

The fleet — **legal, tax, gtm, creative, insurance** — is the training distribution. Each is `{an agent + a known set of gaps}`. The builder's score is how much of each gap its produced eval+loop closes on held-out scenarios. The first dogfood data point already exists: legal-agent's loop, repaired in the session that produced these skills, found a transferable jurisdictional-divergence rule and the gate *correctly refused to ship it until the evidence was valid* — a clean demonstration that the builder's reward must be "real, evidence-backed lift," never "a number went up."

## Anti-patterns (the rulebook smells)

- A skill that lists steps but has **no self-test** — you can't tell if following it worked.
- An "invariant" that's really a **judgment call in disguise** — over-constraining; it should live in Judgment so the agent can adapt it per product.
- A judgment surface with **no evolves-by hook** — it will rot, and nothing will notice.
- A reported lift with **no held-out or no paired-n, or no footprint-matched placebo (neutralization)** — the slot machine. This is the one that ends the product.
