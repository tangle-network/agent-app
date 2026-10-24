# __PROJECT_NAME__

A React chat workspace scaffolded with `create-agent-app`, built on
`@tangle-network/agent-app` and its public UI packages. The maintained
`AgentWorkspaceLayout` owns the rail and History. `ChatComposer`, `ChatMessages`,
and the interaction cards supply the conversation surface.

The existing server vertical supplies better-auth sessions, D1 thread/message
persistence with typed parts and usage receipts, buffered streaming/replay,
file uploads, human-in-the-loop asks, personal API keys, and OpenAI-compatible
access. The agent runs in a real Tangle sandbox. Missing provider credentials
fail explicitly, not through a demo response.

## Layout

| Path | Owns |
|---|---|
| `agent.config.ts`, `prompts/system.md` | Agent identity, model, harness, and persona |
| `web/App.tsx` | Real session auth, workspace navigation, and full History |
| `web/Conversation.tsx` | Conversation assembly and existing chat/replay callbacks |
| `web/api.ts`, `web/uploads.ts` | Product URL, JSON, transcript, and inline-upload adapters |
| `web/styles.css`, `tailwind.config.mjs` | The one Agent App stylesheet entry and the maintained preset |
| `vite.config.mjs`, `web/tsconfig.json` | Standalone browser build and browser-only types |
| `src/chat.ts` | Authentication, store, turn, upload, and interaction factories |
| `src/gateway.ts`, `src/sandbox.ts`, `src/worker.ts` | Existing API gateway, sandbox lane, and HTTP routes |
| `src/db/schema.ts`, `migrations/` | Durable schema and migrations |
| `tests/` | Real server assembly with an explicitly fake sandbox producer |

## Get started

Use the Node and pnpm versions in `.nvmrc` and `package.json`.

```bash
pnpm install
pnpm build
pnpm test
```

The scaffolder creates ignored `.dev.vars` with a fresh local session secret;
it never prints the value or overwrites an existing file. Fill the scoped
Router/Sandbox credentials, choose an authorized model in `agent.config.ts`,
and configure the development D1 binding described in `CUSTOMIZE.md`. Then:

```bash
pnpm db:migrate:local
pnpm dev
```

Open the Worker origin, normally `http://localhost:8787`. Do not put a second
Vite origin in front of cookie auth. Wrangler builds and watches the browser
sources and serves `dist/client`; refresh after a rebuild. `pnpm deploy` uses
the same build hook. Source TSX is never the deployed asset payload.

`pnpm typecheck` checks Worker and browser configurations separately. `pnpm build`
adds the Vite production build. `pnpm exec wrangler deploy --dry-run` checks the
Worker bundle without deployment. `pnpm db:migrate` is the remote migration
command, not part of the local walkthrough.

## Workspace behavior

New thread is `/`; full History is `/?view=history`. Saved conversations keep
`/?threadId=...`, including URLs returned by the API gateway. Native links
support browser back/forward and fresh-process reloads without a second router
or a client-side store of record. Search and sorting cover all pages of the
existing thread API, not just the capped rail.

Auth uses the existing same-origin better-auth endpoints. A successful sign-out
reloads the document. An unavailable session endpoint is an error, not a fake
signed-out or signed-in state. The server remains the only identity authority.

A live send uses the public `chatTurnRequestInit` and `streamChatTurn` helpers.
Reopening a running thread discovers its existing replay handles and refreshes
durable rows rather than appending replay text twice. A failed or ambiguous
accepted POST offers reload, not an automatic second model request.

The template uses `ChatComposer`'s `onSendParts` upload contract. Its upload
endpoint returns inline/sandbox file parts, **not** the stored attachment
records expected by `EntryComposer.uploadUrl`/`useComposerAttachments`.
Do not change that contract just to swap composers. Attachment labels are not
download links. Model, effort, profile, plan-mode, and unsupported thread-action
controls remain absent until their real data and callbacks exist.

## Proof boundaries

The generated server suite executes real migrations, auth, upload, turn,
stored messages, and replay with a fake sandbox producer. It is not a live
model or hosted proof.

The Agent App repository's `pnpm test:generated` additionally installs fresh
packed packages, builds this standalone frontend, and runs Chromium against a
local Worker and D1. It exercises signup, thread creation, History, URL reload,
sign-out, and reopening the same thread after a fresh Worker process and browser
login. It makes no model-turn requests. See the repository's
`create-agent-app/proof/README.md` for evidence and prerequisites.

Before production, complete a real model turn, reload its saved text and usage,
and check live disconnect/replay on the deployed origin. Those checks are not
implied by a local build or no-model browser proof.

## Release canary

`pnpm deploy` ends with `pnpm canary` (`scripts/release-canary.mjs`), which runs
two turns on the deployed origin as a canary member: a plain answer, and a
command only the workspace computer can run. The release fails when either turn
fails, and the log names the computer step's cause from the transcript's
recorded notice. Set `CANARY_URL` (the deployed origin), `CANARY_EMAIL` and
`CANARY_PASSWORD` in the shell that deploys; the first release signs that member
up. A deploy without them fails rather than passing unchecked.
`tests/release-canary.e2e.test.ts` runs the same script against this app's
Worker over local protocol peers.

## Artifact index

`GET /api/files` lists files under `/home/agent/artifacts` for the signed-in
workspace. It returns metadata or `warming`, never provisions a sandbox, and
has no file-download behavior. Reopening saved bytes requires a product-owned,
authorized file reader. Preserve the server access checks and storage semantics.

## External agents

This product serves `/agent-setup.md`, `/llms.txt`, `/llms-full.txt`,
`/agent-api.md` and `/.well-known/tangle-agent.json` without login. These are
customer-facing instructions; `AGENTS.md` is for agents developing this repo.

Sign in to `/?view=api-access` to create an expiring key. Existing accounts and
keys are reused. Read-only access is available by default. Only after the deployment
payer enables execution may an account owner grant `operator:run`
when the agent may use the deployment's paid model/sandbox credentials
and modify workspace files. Keys are scoped and revocable. This template does
not automatically accept Tangle Platform keys or register a Platform product.

`/api/operator/v1` exposes the shared operator contract over the existing
personal workspace and transcript. It reports actual optional capabilities,
returns persisted terminal results, and keeps owner decisions in the browser.
The chat-backed start request normally runs until settlement; it does not
promise durable asynchronous admission. Capped keys are refused for execution,
rather than bypassing their caps through the browser path.

There is no default safe artifact-byte reader. `/api/files` is metadata only.
Products can supply the typed `files`/`assets` adapters to `buildOperatorApi`
for owned, bounded storage. Only configured capabilities are advertised.
Never implement root confinement with a separate symlink check and file read.

External-agent execution is disabled by default (`OPERATOR_RUN_ENABLED="false"`).
Account signup and an account owner selecting a scope do not authorize spending
the deployment payer’s funds. Before explicitly enabling `"true"`, the deployment
payer must review signup/access controls, funding and admission policy. Read-only
keys continue to work. Previously issued run keys are denied while disabled.

All browser and API turns use the shared `TurnStreamDO` workspace lock. Configure
`TURN_STREAM_AUTH_SECRET` in local development and production; missing lock
configuration fails closed before model work. Apply the Wrangler Durable Object
migration when upgrading. A stuck lock needs reconciliation of the existing turn,
not an automatic retry of uncertain effects. Draft text is not terminal evidence.

Historical turns without a retained stream-status identity intentionally report
`unknown`; transcript text alone cannot establish completion. Inspect/reconcile
the original execution rather than rerunning uncertain effects. Workspace locks
do not auto-expire: a crashed detached run stays blocked until cooperative release
or operator reconciliation establishes that the backend has stopped.

Detached execution disables automatic model failover: losing observation before
visible output does not prove the previous backend refused its work. A real
backend result/done is required to release the workspace lock and interpret the
stream status as terminal. Transport loss or EOF retains unknown state and the
lock until an operator reconciles the exact backend execution.
