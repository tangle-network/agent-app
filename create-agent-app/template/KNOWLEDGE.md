# KNOWLEDGE.md — the build-loop and the act-gate

Two different things share the word "knowledge". Keep them straight.

## The two loops

- BUILD LOOP (acquire) — `pnpm knowledge:ingest` → `@tangle-network/agent-app/knowledge-loop`.
  Reads `knowledge/` + `agent.config.ts` `knowledge.sources`, researches, and
  PROPOSES grounded knowledge pages. Source-grounded, propose-don't-apply.
- ACT GATE (block) — `knowledge.requirements` in `agent.config.ts`, scored at runtime
  by the Cloudflare preset's `KnowledgeStateAccessor`. Decides whether the agent
  KNOWS enough to be allowed to propose an action.

Build fills the well; the gate decides if the well is deep enough to act. They are
configured separately and run at different times (ingest is offline/Node; the gate
is per-request).

## Build loop — how to drive it

- [ ] Put domain docs in `knowledge/` and external sources in `knowledge.sources`.
- [ ] `pnpm knowledge:ingest` (DRY) — confirms inputs without spending model calls.
- [ ] Wire a model-backed `driver` and run `--run`:

```ts
import { createKnowledgeLoop } from '@tangle-network/agent-app/knowledge-loop'
import { config } from '../agent.config'

const loop = createKnowledgeLoop(config.knowledge, {
  root: 'knowledge',                       // a KB layout on disk (Node only)
  driver: async ({ systemPrompt, userMessage }) =>
    ({ finalText: await callYourModel(systemPrompt, userMessage) }),
  defaultMinConfidence: config.knowledge.loop?.minConfidence ?? 0.7,
})
const result = await loop.run()
```

Runs in Node (it touches the filesystem). NEVER on the Worker edge path — drive it
from `scripts/knowledge-ingest.mjs`, CI, or a sandbox/delegation context.

## Multimodal sources

The default source adapter is text. To ingest audio / video / image sources, pass a
`SourceAdapter` for that medium via `deps.adapters` — it is tried BEFORE text, so it
claims its media first:

```ts
createKnowledgeLoop(config.knowledge, {
  root: 'knowledge',
  adapters: [audioSourceAdapter],   // tried before the built-in text adapter
  driver,
})
```

Declare such sources in `agent.config.ts` with a `kind` your adapter recognizes
(e.g. `{ uri: 'vault://calls/2026-06.m4a', kind: 'audio' }`).

## Tuning the gate (judges / confidence / freshness)

The build loop accepts a pluggable decider — an agentic judge OR a deterministic /
sandbox check. Defaults to a reviewer that applies a candidate's proposal only when
`confidence >= minConfidence`; below it the proposal is dropped but its SOURCES are
still recorded.

- CONFIDENCE — raise `knowledge.loop.minConfidence` to demand stronger grounding
  before a proposed page is accepted; lower it to accept more, weaker candidates.
- JUDGE — pass a custom `decide` (a `KnowledgeDecider`) to replace the default
  reviewer with your own judge (LLM-as-judge, lint, or sandbox verification).
- FRESHNESS — set `knowledge.loop.freshness` (e.g. `static` / `session` / `daily`);
  the decider receives it to decide whether cached knowledge is still valid.

Per-requirement freshness on the ACT gate is set on each
`KnowledgeRequirementSpec.freshness` — that controls how stale a satisfied
requirement may be before the gate stops crediting it.
