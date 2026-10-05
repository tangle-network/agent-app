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

## Artifact index

`GET /api/files` lists files under `/home/agent/artifacts` for the signed-in
workspace. It returns metadata or `warming`, never provisions a sandbox, and
has no file-download behavior. Reopening saved bytes requires a product-owned,
authorized file reader. Preserve the server access checks and storage semantics.
