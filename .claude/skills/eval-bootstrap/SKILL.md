---
name: eval-bootstrap
description: When a product has NO improvement infrastructure yet, build it for real — elicit the RIGHT target, ground the measurement in external truth, and construct a validated harness (often via a delegated agent-runtime build loop) BEFORE any optimization spend. The anti-toy, anti-circular skill: it exists so the improver moves what the user actually wants, not a measurable proxy it invented.
---

# Eval Bootstrap — build the apparatus for real, at cold start

Cold start is the most dangerous moment in the whole stack. There is no eval, so the agent is tempted to invent one — and **an invented eval optimizes an invented target.** Your job here is to build a measurement of the thing the *user* actually values, grounded in something *real*, and prove it works *before a dollar is spent optimizing against it*. You are a builder, not a tuner: if the apparatus does not exist, you construct it — delegating a coding / agent-runtime build loop that runs to completion when the work is substantial.

This skill is what makes the Improve button honest at cold start. Held by the delegated builder; gated by `improve-conductor`; it hands off to `surface-evolution` only once the harness is validated.

## The two loops — never collapse them

- **BUILD loop** — construct + *validate* the harness: representative scenarios, **externally-grounded** gold, a scorer that passes the mutation test, a held-out split, and the wiring for the single surface to evolve. The done-criterion is **`measurement-validation` passes** — not "the files exist." When the build is substantial, mechanical, or long-running, **delegate it to an agent-runtime driven loop** that builds to completion in its own sandbox and returns a validated harness.
- **IMPROVE loop** — optimize the surface against the now-trusted harness (`surface-evolution`). **Starts only after BUILD exits clean.**

"I built an eval and it shows improvement," said in one breath, is the toy. The gate between the two loops is the product.

## Invariant (non-negotiable)

1. **No optimization spend until: (a) the target is user-confirmed and tied to a product-value claim, (b) the gold is grounded in EXTERNAL real truth, and (c) the harness passed `measurement-validation`.** The BUILD loop returns a *validated* harness or it isn't done.
2. **Gold is grounded in external reality** — the user's accepted past outputs, reference documents, real records, or human labels. **NEVER gold the agent generates and then optimizes against.** That is grading its own homework: the number always rises and means nothing. If you cannot name the external source of the gold, it is circular — stop.
3. **The target is the thing the user would REJECT a draft over** — not the easiest thing to measure. If you're scoring length / format / keyword presence while the user cares about correctness / usefulness / persuasiveness, you are building a toy. Re-elicit.
4. **If grounding does not exist, ACQUIRE it** — ask the user for examples, pull references, label a seed set — do not fabricate it. (This is where `@tangle-network/agent-app/knowledge-loop`'s source-grounded, propose-don't-apply acquisition plugs in.)

## Judgment (figure this out per product)

- What does the user *actually* value about this artifact? Extract it, confirm it, phrase it as a product-value claim. The user is often unsure — anticipate the decision-relevant quality and propose it.
- What external truth can ground it, and is there *enough* (the data threshold)? If not, what's the cheapest way to acquire real grounding?
- What's the *minimal real* harness — fewest scenarios, simplest scorer — that still measures the real thing? **Small and real beats big and toy.**
- Build inline, or delegate an agent-runtime loop to construct it? Delegate when it's substantial or long-running; the loop is accountable for returning a *validated* harness.

## Self-test

- **The "would the user agree?" test:** show the user 2–3 scored examples — one high, one low. Do they agree with the scores? If not, the measurement is wrong; fix it before optimizing. This single check kills most toys.
- **The mutation test:** an obviously-better and an obviously-worse artifact move the score in the right direction and magnitude. (A metric that doesn't move is measuring the wrong channel — see `eval-architect`.)
- **The non-circularity check:** name the external source of the gold. If you can't, it's circular — stop.
- **It RUNS, not just compiles:** a baseline produces a real, non-zero, plausible score against the grounded gold.

## Evolves-by

When an improve loop later ships a "win" the user *rejects*, the bootstrap mis-framed the target or mis-grounded the gold — that rejection becomes a sharper elicitation / grounding rule. The bootstrap's judgment surface is optimized by the meta-eval *"did harnesses built this way produce lifts the user accepted as real?"* See `skill-evolution`.

## Why this is the accountable skill

The improver is tasked with *moving the thing the user wants moved* — end to end: elicit the target, ground it, build the apparatus (constructing it for real when it's missing), run the loop, report the honest lift, iterate to threshold or budget. It is accountable to the real improvement, not to "I ran a loop." But it will **not** spend the user's money optimizing a target it made up — it builds the right measurement first, or it tells the user what it needs to.
