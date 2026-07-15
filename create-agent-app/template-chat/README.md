# __PROJECT_NAME__

A multimodal chat agent product scaffolded with `create-agent-app --chat`, built
on [`@tangle-network/agent-app`](https://github.com/tangle-network/agent-app):
the whole server chat vertical — better-auth sessions, thread/message
persistence with typed parts + usage receipts, streaming turns with buffered
replay, file uploads, human-in-the-loop asks — assembled from shell factories.
The agent itself runs in a Tangle sandbox (a full harness: skills, tools, bash,
MCP); this app coordinates UI, durability, and access around it.

## Layout

| Path | Surface | Edit when |
|---|---|---|
| `agent.config.ts` | DATA — name, model default, harness, ask kinds | defining the agent |
| `prompts/system.md` | DATA — the persona (imported as a Text module) | shaping behavior |
| `src/chat.ts` | CODE — the composer (factories → the chat vertical) | extending seams |
| `src/sandbox.ts` | CODE — the sandbox lane (boxes, credentials, profile) | provisioning changes |
| `src/worker.ts` | CODE — HTTP routing only | adding an endpoint |
| `src/db/schema.ts` | CODE — auth tables + `createChatTables()` | schema changes (+ migration) |
| `migrations/` | SQL the e2e test executes for real | schema changes |
| `public/index.html` | the dev chat page (not the product UI) | never — replace it (CUSTOMIZE ⑤) |
| `tests/` | the e2e turn gate this app ships with | extending coverage |

## Get started

```bash
pnpm install
pnpm typecheck && pnpm test   # green before you edit anything
```

Then walk the trail:

1. `AGENTS.md` — the behavior contract (you are customizing a chat agent-app).
2. `CUSTOMIZE.md` — the ordered fill-checklist, from persona to deploy.

## Scripts

- `pnpm dev` — run the worker + dev page locally (fill `wrangler.toml` + `.dev.vars` first).
- `pnpm db:migrate:local` / `pnpm db:migrate` — apply `migrations/` to D1.
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm test` — vitest, including the end-to-end turn gate (fake sandbox
  producer → streamed turn → persisted transcript → replay).
- `pnpm deploy` — `wrangler deploy`.

## Invariants

Identity comes from the session, never a request body. Inaccessible threads
read as 404. No mock agent — missing sandbox credentials fail loud. See
`AGENTS.md` for the full contract.
