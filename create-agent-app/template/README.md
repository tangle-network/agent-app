# __PROJECT_NAME__

A Tangle agent product scaffolded with `create-agent-app`, built on
[`@tangle-network/agent-app`](https://github.com/tangle-network/agent-app) (the
application-shell framework) + the Cloudflare preset (D1 + Drizzle + KV).

## Layout

| Path | Surface | Edit when |
|---|---|---|
| `agent.config.ts` | DATA — identity, taxonomy, knowledge gate, integrations | defining the agent |
| `knowledge/` | DATA — domain documents the agent grounds on | adding domain knowledge |
| `src/agent-app.ts` | CODE — the composer (config + bindings → shell seams) | overriding a handler |
| `src/worker.ts` | CODE — the chat route | extending the route / auth |
| `scripts/knowledge-ingest.mjs` | the build-loop entry (`pnpm knowledge:ingest`) | ingesting knowledge |

## Get started

```bash
pnpm install
pnpm typecheck && pnpm test
```

Then walk the trail:

1. `AGENTS.md` — the behavior contract (you are customizing an agent-app).
2. `CUSTOMIZE.md` — the ordered fill-checklist.
3. `KNOWLEDGE.md` — build-loop vs act-gate.

## Scripts

- `pnpm dev` — run the worker locally (fill `wrangler.toml` first).
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm test` — vitest.
- `pnpm knowledge:ingest` — enumerate + drive the knowledge acquisition loop.
- `pnpm deploy` — `wrangler deploy`.

## Invariants

Regulated proposals are human-approved and never auto-execute. Domain figures are
grounded in real records, never fabricated. See `AGENTS.md` for the full contract.

## External-agent readiness

Public `/agent-setup.md`, `/llms.txt` and `/.well-known/tangle-agent.json` describe
this skeleton's readiness truthfully. The default `/chat` fails closed with
503 `auth.not_configured`. Install a trusted `HeadlessAuth.authenticate`
resolver through `createWorker` before enabling it. Never derive identity from
request-body userId/workspaceId. Update the public contract only after proving
real authentication, authorization, spending and results. Use the default chat
template for the assembled local-key operator API and browser owner setup.
