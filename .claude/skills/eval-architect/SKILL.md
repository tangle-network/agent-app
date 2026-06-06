---
name: eval-architect
description: Build a measurement that scores an agent's REAL deliverable — not a proxy — for a product you've never seen before. Use when scaffolding or repairing the eval an Improve loop optimizes against. Get this wrong and every downstream optimization perfects a fiction.
---

# Eval Architect — measure the real deliverable

You are building the measurement an improvement loop will optimize against. **The loop optimizes whatever you measure.** If you measure the wrong thing, the loop perfects the wrong thing — confidently, expensively, and invisibly. The measurement is the product. Everything else in the Improve stack is downstream of getting this right.

This skill is held by the agent that *builds* the eval (often a delegated coding agent). Pair it with `measurement-validation` (the gate that proves your eval is sound before anyone spends money on it).

## The cardinal question

**Where does this agent's deliverable actually land?** Prose in the reply? Validated tool calls? Persisted artifacts (vault docs, DB rows)? A PR? A rendered UI? Find out by inspecting *real runs* — never by assuming it's the chat text.

> Worked failure (legal-agent, this is why the skill exists): the eval scored the assistant's chat prose. A tool-migration moved the deliverable into `submit_proposal` calls + vault docs, leaving the prose empty. Every scorer reading prose silently collapsed to ~0. The loop would have optimized an empty string. The deliverable had *moved* and the measurement didn't follow it.

## Invariant (non-negotiable — violate these and the loop is a slot machine)

1. **Score the produced artifact, not the conversation.** Locate the real output channel and score *that*.
2. **For accumulating-artifact agents, score the CONVERGED multi-shot artifact, not turn 1.** Most real agents build their deliverable over several turns. Define a convergence criterion (e.g. the artifact stops growing for N shots) and score the converged state.
3. **A held-out split exists and is never trained on.** No held-out → no honest gate → no trustworthy lift.
4. **Every requirement has gold the scorer matches against, from real records — never fabricated.** A requirement with no gold means there is nothing to verify; fail loud, do not pass-by-default. A fluent hallucination that produced nothing must score 0, not 0.9.

## Judgment (figure this out per product — the agentic core)

- What *is* the deliverable here, and where does it persist? Read the runtime events / tool calls / storage, not the transcript.
- What is the convergence criterion for this agent's artifact? When has it stopped accumulating?
- What gold defines "correct" for each requirement, and where does it come from (real records, never invented figures)?
- Which dimensions matter, and what are their weights? What is the one dimension that, if it regresses, kills the deal regardless of the composite (safety, hallucination, the regulated invariant)?

## Self-test (prove the metric works before trusting it)

- **Baseline sanity:** run it. Is the score non-zero and plausible for a competent agent? A near-zero baseline usually means you're scoring the wrong channel, not that the agent is terrible.
- **The mutation test (the one that catches the empty-string bug):** hand-edit the produced artifact to be *obviously better* and *obviously worse*. Does the score move in the right direction and magnitude? A metric that doesn't move under obvious changes is measuring the wrong thing.
- **Audit EVERY scoring surface together.** Completion, quality, and the optimizer's own scorer all read *something*. When the deliverable's channel moves, all of them that read the old channel silently zero. (Session: completion + quality were fixed; the optimizer's own scorer was missed and only found by tracing. Three surfaces — enumerate them, don't assume one.)

## Evolves-by

When a later optimization shows lift on *training* but none on *held-out*, your eval was overfittable or gameable — add the gap it missed as a new judgment rule. The architect's judgment surface is itself optimized by the meta-eval *"did evals built this way yield real held-out lift, no critical regression?"* See `skill-evolution`.

## Fleet as dogfood

legal / tax / gtm / creative / insurance each put their deliverable in a *different* channel — filings, forms, published copy, rendered artifacts, routed proposals. The skill is general precisely because it forces you to *locate* the channel for the product in front of you rather than hardcode "the reply text."
