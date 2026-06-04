# CUSTOMIZE.md — fill this project, in order

This is the trail. Walk it top to bottom. Each step is a checklist item paired with
the DISCOVERY QUESTION it answers — answer the question, then make the edit. The
whole job is filling `agent.config.ts` (DATA) and seeding `knowledge/` (DATA). You
touch `src/` only at step ⑤ and only if the preset can't express your stack.

When every box is checked and `pnpm typecheck && pnpm test && pnpm knowledge:ingest`
are green, the agent is customized.

---

## ① Identity — `agent.config.ts` → `identity`

Discovery: **Whose job does this agent do, in whose voice, under what hard rules?**

- [ ] Set `identity.name` to the product/agent name.
- [ ] Rewrite `identity.persona` as the real one-paragraph role + voice + remit. This
      is the spine of the system prompt.
- [ ] Add hard rules + standing-workflow summaries to `systemPromptFragments`.
- [ ] Keep/edit the grounding rule and the `not-advice` disclaimer. Add any
      regulatory notice your domain requires under `disclaimers`.

## ② Taxonomy — `agent.config.ts` → `taxonomy`

Discovery: **Which actions change client state or are legally gated, so a certified
human must approve before they execute?**

- [ ] List every action the agent can PROPOSE in `proposalTypes`.
- [ ] Put the regulated/state-changing subset in `regulatedTypes`. These cannot
      auto-execute — they fail-closed to the approval queue.
- [ ] Confirm `regulatedTypes` ⊆ `proposalTypes` (the test checks this).

## ③ Knowledge requirements (the ACT gate) — `agent.config.ts` → `knowledge.requirements`

Discovery: **What is the minimum the agent must have GROUNDED before it's allowed to
propose? What facts gate the loop?**

- [ ] For each gating fact, add a `KnowledgeRequirementSpec` with a declarative
      `satisfiedBy`:
  - a config field is set → `{ config: 'dot.path', nonEmpty: true }`
  - rows exist in a workspace-scoped table → `{ table: 'name', minRows: N, statusIn: [...] }`
  - combine with `{ anyOf: [...] }` / `{ allOf: [...] }`
- [ ] Use a `derive` function ONLY for a rule the declarative form can't express.
- [ ] Pick a real `category` / `acquisitionMode` / `importance` per spec (the
      autocomplete lists the allowed values).

## ④ Domain docs + research sources — `knowledge/` + `agent.config.ts` → `knowledge.sources`

Discovery: **What does the agent need to READ to be grounded, and where does fresh
knowledge come from?**

- [ ] Drop your real domain documents into `knowledge/` (md/txt/json, one topic per
      file). See `knowledge/README.md`.
- [ ] List external research sources in `knowledge.sources` (URLs, regulation feeds,
      integration refs) with a `kind`.
- [ ] Tune `knowledge.loop` (`goal`, `minConfidence`, `freshness`) — see KNOWLEDGE.md.

## ⑤ Integrations — `agent.config.ts` → `integrations.enabled` (+ `src/` only if needed)

Discovery: **Which CRMs / data sources / messaging channels does the workflow touch?**

- [ ] Add the `@tangle-network/agent-integrations` catalog kinds to `enabled`.
- [ ] Only if the house preset can't persist your data: override a single handler in
      `src/agent-app.ts`. Default to the preset; do not fork the shell.

## ⑤b Delegation (optional) — `agent.config.ts` → `delegation`

Discovery: **Should the agent spawn background research/code loops in their own sandbox?**

- [ ] Leave `delegation.enabled: false` unless the agent does long multi-step research or
      document generation that should run to completion out-of-band.
- [ ] If enabled (sandbox path only): spread `delegationMcpForConfig(config, { apiKey:
      env.TANGLE_API_KEY, forwardEnv: env })` from `@tangle-network/agent-app/delegation`
      into your sandbox profile's `mcp` map. Never reimplement the loop — the module is the seam.

## ⑥ Ingest — `pnpm knowledge:ingest`

Discovery: **Did the loop pick up exactly the docs and sources I expect?**

- [ ] Run `pnpm knowledge:ingest` (DRY). Confirm the listed docs + sources match.
- [ ] Wire a model-backed driver + decider, then `pnpm knowledge:ingest --run` to
      drive the acquisition loop (see KNOWLEDGE.md).

## ⑦ Verify

Discovery: **Does the customized agent hold its contract?**

- [ ] `pnpm typecheck` — clean.
- [ ] `pnpm test` — green (invariants + composer wiring).
- [ ] `pnpm knowledge:ingest` — enumerates without error.
- [ ] Fill `wrangler.toml` (D1 id, KV id, `MODEL_NAME`), run the preset migration,
      then `pnpm dev` to exercise `/chat` for real.
