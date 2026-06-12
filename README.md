# @tangle-network/agent-app

[![npm](https://img.shields.io/npm/v/@tangle-network/agent-app.svg)](https://www.npmjs.com/package/@tangle-network/agent-app)
[![npm provenance](https://img.shields.io/badge/npm-provenance-blue.svg)](https://www.npmjs.com/package/@tangle-network/agent-app#provenance)
[![license](https://img.shields.io/npm/l/@tangle-network/agent-app.svg)](./LICENSE)

The application-shell layer for building agent products on the Tangle stack.

The substrate packages — `@tangle-network/agent-runtime`, `agent-eval`, `agent-integrations`, `tcloud`, `sandbox` — are the **engine**. This package is the **shell**: the chat tool-loop, the structured agent→app side channel, the integration-hub client, per-workspace billing, field crypto, and the web boundary utilities that every agent app otherwise rewrites by hand. You supply your domain through typed seams; the package supplies the mechanism and imports none of your code.

## Highlights

- **Structured tool side channel** — `submit_proposal` (approval-gated), `schedule_followup`, `render_ui`, `add_citation`, exposed as validated tool calls over three surfaces (HTTP route, per-turn MCP server, agent-runtime executor). No fenced-text parsing.
- **Bounded tool loop** — `runAppToolLoop` / `streamAppToolLoop`: stream a turn → collect tool calls → dispatch → fold results back → re-run, capped. Substrate-free behind a `streamTurn` seam, so it drives a sandboxed agent, a Worker, or an in-browser copilot unchanged.
- **Sandbox-optional** — the same tools, billing, eval, and loop work without a container. A `fetch`-only adapter maps any OpenAI-compatible stream (Tangle Router, tcloud) into the loop. See [`examples/browser-copilot.md`](./examples/browser-copilot.md).
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
| `@tangle-network/agent-eval` | `/eval` | `>=0.50.0` |
| `@tangle-network/agent-integrations` | `/integrations`, `/tangle` | `>=0.32.0` |

The substrate-free modules (`/runtime`, `/tools`, `/web`, `/crypto`, `/redact`, `/stream`, `/billing`) need no peers.

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

## How it's organised

One rule decides where anything lives:

> Does the capability make sense **without** a specific app's tool side channel, approval queue, or chat route?
> **Yes** → it belongs in an engine package (contribute it down).
> **No** → it's app-shell, and it belongs here.

Everything here is reached through a typed seam — `AppToolHandlers`, `AppToolTaxonomy`, `streamTurn`, `executeToolCall`, `verifyToken`, `KeyProvisioner` / `WorkspaceKeyStore` / `KeyCrypto`. The package never imports product code and never hard-codes a domain value (a proposal type, a premium, a disclaimer); each is a parameter. New capability arrives as a new subpath, never a breaking change to an existing one.

## Modules

Each is an independent entry point — import only what you use.

| Subpath | What it gives you |
|---|---|
| [`/tools`](src/tools) | The structured agent→app side channel: `buildAppToolOpenAITools`, `createAppToolRuntimeExecutor`, `handleAppToolRequest` (HTTP), `buildAppToolMcpServer` / `buildHttpMcpServer` (MCP), `createCapabilityToken` + `authenticateToolRequest` (capability auth), `ToolInputError`. |
| [`/runtime`](src/runtime) | `runAppToolLoop` / `streamAppToolLoop` (bounded tool loop), `resolveTangleModelConfig` (Tangle Router / Anthropic BYOK), and `toLoopEvents` / `createOpenAICompatStreamTurn` (OpenAI-compat stream → loop events, with fragmented tool-call args reassembled). |
| [`/integrations`](src/integrations) | Integration-hub client: `HubExecClient`, `resolveIntegrationAction`, `invokeIntegrationHub`. Composes `@tangle-network/agent-integrations`. |
| [`/eval`](src/eval) | `producedFromToolEvents` (bridge tool events into the eval verifier) and `createTokenRecallChecker` (deterministic content check). Re-exports `@tangle-network/agent-eval`'s `verifyCompletion`, `extractProducedState`, `weightedComposite`, `createLlmCorrectnessChecker`. |
| [`/tangle`](src/tangle) | App-registration consent URL (`buildConsentUrl`) and a cached, auto-refreshing broker-token provider (`createBrokerTokenProvider`). Structural over the tcloud client. |
| [`/billing`](src/billing) | `createWorkspaceKeyManager` — mint / rotate / roll over / report usage on per-workspace, budget-capped model keys. Seams for provisioner, store, and crypto. |
| [`/delegation`](src/delegation) | `buildDelegationMcpServer` — the agent-runtime driven-loop MCP (`delegate_research`, `delegate_code`, `delegation_status`) for multi-step work that runs to completion in its own sandbox. Opt-in. |
| [`/crypto`](src/crypto) | AES-GCM field encryption: `encryptAesGcm`, `decryptAesGcm`, `createFieldCrypto`. Key supplied by the caller. |
| [`/web`](src/web) | Request-boundary utilities: `parseJsonObjectBody`, `requireString`, `extractRequestContext`, `checkRateLimit`, `addSecurityHeaders`. |
| [`/stream`](src/stream) | SSE normalization and turn identity: `normalizeToolEvent`, `resolveChatTurn`, `encodeEvent`, message-part merging. |
| [`/redact`](src/redact) | `redactForIngestion` — PII redaction before content leaves the boundary. |

The root entry (`@tangle-network/agent-app`) re-exports every module, but importing the subpath keeps your bundle to what you use.

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
