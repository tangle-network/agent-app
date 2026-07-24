# @tangle-network/agent-app

[![npm](https://img.shields.io/npm/v/@tangle-network/agent-app.svg)](https://www.npmjs.com/package/@tangle-network/agent-app)
[![npm provenance](https://img.shields.io/badge/npm-provenance-blue.svg)](https://www.npmjs.com/package/@tangle-network/agent-app#provenance)
[![license](https://img.shields.io/npm/l/@tangle-network/agent-app.svg)](./LICENSE)

The application-shell layer for building agent products on the Tangle stack.

The substrate packages — `@tangle-network/agent-runtime`, `agent-eval`, `agent-integrations`, `tcloud`, `sandbox` — are the **engine**. This package is the **shell**: the chat tool-loop, the structured agent→app side channel, the integration-hub client, per-workspace billing, field crypto, and the web boundary utilities that every agent app otherwise rewrites by hand. You supply your domain through typed seams; the package supplies the mechanism and imports none of your code.

**Who it's for:** engineers building an agent product on the Tangle sandbox — a chat app, a copilot, an autonomous worker — who want the shell (chat routes, streaming, durability, approvals, billing, the tool side channel) as composable pieces instead of a per-app rewrite. It is **not** an agent framework or a model SDK: the reasoning lives in the sandbox agent; agent-app is everything around it — the turn plumbing, durability, and money.

## Highlights

- **Structured tool side channel** — `submit_proposal` (approval-gated), `schedule_followup`, `render_ui`, `add_citation`, exposed as validated tool calls over three surfaces (HTTP route, per-turn MCP server, agent-runtime executor). No fenced-text parsing.
- **Bounded tool loop** — `runAppToolLoop` / `streamAppToolLoop`: stream a turn → collect tool calls → dispatch → fold results back → re-run, capped. Substrate-free behind a `streamTurn` seam, so it drives a sandboxed agent, a Worker, or an in-browser copilot unchanged.
- **Assembled chat vertical** — `createChatTurnRoutes` wires auth → thread/message store → streaming turn with buffered replay → uploads → sidecar question answering into one route factory, over `authorize` / `produce` / `store` / `interactions` seams. No hand-rolled orchestration. See [`examples/chat-app.md`](./examples/chat-app.md).
- **Sandbox-optional** — the same tools, billing, eval, and loop work without a container. A `fetch`-only adapter maps any OpenAI-compatible stream (Tangle Router, tcloud) into the loop. See [`examples/browser-copilot.md`](./examples/browser-copilot.md).
- **Resumable turns (sandbox-free path)** — for a browser/edge copilot streaming the Router directly, buffer a turn so a dropped tab loses nothing and a reconnecting client replays the tail. **Sandbox products don't need this** — the sandbox SDK already buffers + replays sessions (`streamPrompt` + `lastEventId`). See [`examples/resumable-turns.md`](./examples/resumable-turns.md).
- **Composes the engine, never forks it** — `/eval` re-exports `@tangle-network/agent-eval`'s verifier; `/integrations` wraps the hub; `/tangle` and `/billing` take the tcloud client as a structural contract. Engines are **peer dependencies** — you pin the version, nothing is bundled.
- **ESM, typed, zero runtime deps** in the substrate-free modules (`/runtime`, `/web`, `/crypto`, `/redact`, `/stream`). Ships with `.d.ts` and npm [provenance](https://www.npmjs.com/package/@tangle-network/agent-app#provenance).

## Install

```bash
pnpm add @tangle-network/agent-app
```

The engine packages you actually use are **peer dependencies** — install the ones your modules touch:

```bash
# /eval composes the eval engine; /integrations composes the hub client
pnpm add @tangle-network/agent-eval @tangle-network/agent-integrations
```

| Peer | Required by | Range |
|---|---|---|
| `@tangle-network/agent-eval` | `/eval`, `/eval-campaign`, `/profile`, `/knowledge` | `>=0.100.0` |
| `@tangle-network/agent-runtime` | `/runtime`, `/knowledge-loop`, runtime tool execution | `>=0.79.3` |
| `@tangle-network/agent-integrations` | `/integrations`, `/tangle` | `>=0.32.0` |

Modules that do not import engine packages (`/tools`, `/web`, `/crypto`, `/redact`, `/stream`, `/billing`) need no peers.

## Quick start

A product supplies its **taxonomy** (which proposal types exist, which are approval-gated) and its **handlers** (the real DB/vault writes), then wires the tool side channel to whichever surface it runs on.

```ts
import {
  buildAppToolOpenAITools,
  createAppToolRuntimeExecutor,
  type AppToolHandlers,
  type AppToolTaxonomy,
} from '@tangle-network/agent-app/tools'
import { runAppToolLoop } from '@tangle-network/agent-app/runtime'

// 1. Declare the domain (the package bakes in no proposal types or rules).
const taxonomy: AppToolTaxonomy = {
  proposalTypes: ['recommend', 'contact', 'other'],
  regulatedTypes: ['recommend', 'contact'], // these require a certified approver
}

// 2. Provide the side effects — your store, your validation.
const handlers: AppToolHandlers = {
  submitProposal,
  scheduleFollowup,
  renderUi,
  addCitation,
}

// 3. Advertise the tools to the model and route their execution.
const tools = buildAppToolOpenAITools(taxonomy)
const executeToolCall = createAppToolRuntimeExecutor({
  handlers,
  taxonomy,
  ctx: { userId, workspaceId, threadId },
})

// 4. Run a bounded, tool-driven turn loop over any backend.
const result = await runAppToolLoop({
  systemPrompt,
  userMessage,
  streamTurn,                                       // wrap your model / runAgentTaskStream
  executeToolCall,
  isExecutableTool: (name) => tools.some((t) => t.function.name === name),
})

console.log(result.finalText, result.toolResults)
```

`streamTurn` is the one seam that varies by backend. For an in-browser or edge copilot talking to an OpenAI-compatible endpoint, you don't write it by hand:

```ts
import { createOpenAICompatStreamTurn, resolveTangleModelConfig } from '@tangle-network/agent-app/runtime'

const cfg = resolveTangleModelConfig() // reads provider/model/key/baseUrl from env, or pass literals
const streamTurn = createOpenAICompatStreamTurn({ ...cfg, tools })
```

The full three-transport walkthrough (Tangle Router, tcloud, Vercel AI SDK) is in [`examples/browser-copilot.md`](./examples/browser-copilot.md).

Building the full **server chat vertical** instead — auth, thread/message tables, a streaming turn with buffered replay, uploads, and sidecar question answering — is the job of `createChatTurnRoutes` (`/chat-routes`) and the modules around it. The end-to-end assembly, including the durable plan/question workflow and the client composer, is in [`examples/chat-app.md`](./examples/chat-app.md).

## How it's organised

One rule decides where anything lives:

> Does the capability make sense **without** a specific app's tool side channel, approval queue, or chat route?
> **Yes** → it belongs in an engine package (contribute it down).
> **No** → it's app-shell, and it belongs here.

Everything here is reached through a typed seam — `AppToolHandlers`, `AppToolTaxonomy`, `streamTurn`, `executeToolCall`, `verifyToken`, `KeyProvisioner` / `WorkspaceKeyStore` / `KeyCrypto`. The package never imports product code and never hard-codes a domain value (a proposal type, a premium, a disclaimer); each is a parameter. New capability arrives as a new subpath, never a breaking change to an existing one.

## Choosing a path

Three decisions cover most of the surface.

**1. How does the turn run?** Pick the transport by who's watching, not by feature.

| Your turn | Use | Why |
|---|---|---|
| **Interactive** — a user is watching a chat or copilot | `streamPrompt` held open for the turn; the sandbox gateway lets the browser attach directly | Worker lifetime ≈ turn length; a dropped tab replays the buffered tail on reconnect. |
| **Autonomous** — a mission step, queue job, cron, or inbound email, with nobody watching | `dispatchPrompt({ detach: true })` + poll from a durable driver. `runDetachedTurn` (`/chat-routes`) bridges that detached run into the live buffer, so a browser opening the session mid-run still tails it token-by-token | No consumer exists and Workers die in minutes; the platform runs the turn server-side and a crash re-dispatch is a lookup, not a second run. |
| **Eval / CI** — a long-lived harness process | `runAppToolLoop` / `streamPrompt` in-process | The process outlives the run; durability adds nothing — a failed run is re-run, not resumed. |

**2. Assembled or à la carte?** `createChatTurnRoutes` (`/chat-routes`) wires the whole server chat turn — auth, store, streaming, replay, uploads, interactions — over typed seams. Reach for the individual modules (`/stream`, `/chat-store`, `/interactions`) only to compose something the assembled route doesn't cover.

**3. Sandbox or sandbox-free?** The tools, billing, eval, and loop all work without a container: `createOpenAICompatStreamTurn` maps any OpenAI-compatible endpoint into the loop for a browser or edge copilot. Reach for `/sandbox` only when the turn needs a real container — bash, files, sub-agents, MCP.

## Modules

Each subpath is an independent entry point — import only what you use; the root re-exports everything, but a subpath import keeps your bundle to what you touch.

The **complete, always-current reference** — every published subpath, its exported symbols, and its internal dependencies — is generated into **[`docs/CODEMAP.md`](./docs/CODEMAP.md)** and kept honest by a CI check (regenerate with `pnpm docs:gen`). Start with the core entry points:

**Run a turn**
- [`/tools`](src/tools) — the structured agent→app side channel (proposals, follow-ups, citations, UI) as validated tool calls, over HTTP / MCP / runtime-executor surfaces.
- [`/runtime`](src/runtime) — the bounded tool loop; the same loop drives a sandbox agent, a Worker, or an in-browser copilot behind one `streamTurn` seam.

**The server chat vertical** ([`examples/chat-app.md`](./examples/chat-app.md))
- [`/chat-routes`](src/chat-routes) — `createChatTurnRoutes`: auth → store → streaming turn with buffered replay → uploads → sidecar question answering, assembled. Plus `runDetachedTurn` for autonomous turns a browser can still watch live.
- [`/chat-store`](src/chat-store) · [`/interactions`](src/interactions) · [`/durable-chat`](src/durable-chat) · [`/plans`](src/plans) — persistence, human-in-the-loop asks, and the durable plan/question workflow around them.

**On the sandbox**
- [`/sandbox`](src/sandbox) — workspace provisioning + turn streaming.
- [`/missions`](src/missions) — durable multi-step orchestration: sequencing, budgets, approval gates, schedules.

**React surfaces**
- [`/web-react`](src/web-react) — router-safe chat + observability components (never imports sandbox-only UI); [`/composer`](src/composer) when the chat owns a full sandbox profile.

**Utilities (zero-dependency)**
- [`/web`](src/web) · [`/stream`](src/stream) · [`/crypto`](src/crypto) · [`/redact`](src/redact) — request boundary, SSE normalization, field crypto, PII redaction.

See **[`docs/CODEMAP.md`](./docs/CODEMAP.md)** for the rest — `/billing`, `/tangle`, `/object-store`, `/trace`, `/theme`, `/eval`, `/app-auth`, `/platform`, and more.

### Missions: id shape and product columns

Two `createMissionService` seams adopters hit on day one:

- **`generateId`** (on `MissionServiceOptions`) defaults to `crypto.randomUUID()` — a 36-char dashed UUID. If your mission table has an existing id shape (e.g. 32-hex to match D1 row defaults), inject your own generator; the service stamps it verbatim on the inserted record.
- **`CreateMissionInput.extras`** carries opaque product-column values (a `workflowId` FK, a source-turn pointer) verbatim to `MissionStorePort.insert(record, extras)`, so creation is a single write — no post-insert stamp. The service never reads them.

## Compatibility

- **ESM only.** Ships `import` + `types` conditions per subpath.
- **Runtimes:** Node ≥ 20, Cloudflare Workers / edge, and the browser (the substrate-free modules use only Web-standard APIs — `fetch`, Web Crypto, `TextEncoder`).
- **TypeScript:** strict; full `.d.ts` for every entry point.

## Contributing

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

Build is [tsup](https://tsup.egoist.dev) (ESM + `.d.ts`), tests are [vitest](https://vitest.dev). A change keeps the suite green and follows the layering rule above — anything engine-general is contributed down to the substrate, not duplicated here. See [AGENTS.md](./AGENTS.md) for the full contributor contract.

## License

[MIT](./LICENSE)
