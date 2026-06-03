# @tangle-network/agent-app

Shared **application-shell framework** for Tangle agent products (insurance, tax, legal, creative, gtm, agent-builder). The substrate packages (`@tangle-network/{sandbox, agent-runtime, agent-eval, agent-integrations, agent-knowledge, tcloud}`) are the *engine*; this package is the *shell* — the opinionated, reusable application layer those products currently fork-duplicate.

The goal: a product should `pnpm add @tangle-network/agent-app`, supply its domain seams (schema, prompt, taxonomy, persistence), and get the whole shell — instead of copy-forking another agent app and inheriting its bugs (the way insurance forked legal and inherited legal's IRS/FinCEN filing scripts).

Everything here is **domain-seamed**: the generic mechanism lives in the package; each product supplies callbacks/config for the domain-specific bits. The package imports no product code.

## Modules

| Subpath | Status | What it is |
|---|---|---|
| `@tangle-network/agent-app/tools` | ✅ **shipped + tested** | The structured agent→app tool side channel — `submit_proposal` (approval-gated), `schedule_followup`, `render_ui`, `add_citation`. OpenAI tool defs, MCP-server builder, HTTP route handler, agent-runtime executor, capability auth. Replaces brittle fenced `:::` blocks with validated tool calls. Seam: `AppToolHandlers` + `AppToolTaxonomy`. |
| `@tangle-network/agent-app/delegation` | ✅ **shipped + tested** | The agent-runtime "driven loop" MCP (`delegate_research` / `delegate_code` / `delegation_status` …) for multi-step work that runs to completion in its own agent-driver sandbox. Optional; opt in by spreading into the profile `mcp` map. |
| `@tangle-network/agent-app/tangle` | ✅ **shipped + tested** | Tangle login (SSO) + the developer self-service **app-registration → broker-token** flow: `buildConsentUrl` (one-time user consent) + `createBrokerTokenProvider` (caches/auto-refreshes the `sk-tan-broker-` token per durable grant, shares in-flight mints). Structural (depends on the minter contract; pass the concrete `TangleAppsClient` from `@tangle-network/agent-integrations`). |
| `@tangle-network/agent-app/runtime` | ✅ **shipped + tested** | `runAppToolLoop` — the bounded multi-turn tool loop every app's chat runtime hand-rolls: stream a turn → collect tool calls → dispatch → fold results back → re-run, capped. Substrate-free via a `streamTurn` seam (wrap any backend / `runAgentTaskStream`) + an `executeToolCall` seam (route to integration + app-tool executors). |
| `@tangle-network/agent-app/eval` | ✅ **shipped + tested** | The inline completion gate: `producedFromToolEvents` (bridge `/tools` produced events), `verifyCompletion` (per-requirement `satisfiedBy` gate), `tokenRecallChecker` (deterministic content check), `weightedScore`. For full campaigns/traces/LLM-judge use `@tangle-network/agent-eval`; this composes with it. |

✅ = built, typechecked, unit-tested, builds. All five modules done — 39 tests.

## `/tools` usage (the shipped module)

A product supplies its taxonomy + handlers (its real DB/vault ops), then wires the three surfaces:

```ts
import {
  buildAppToolOpenAITools, createAppToolRuntimeExecutor, handleAppToolRequest,
  buildAppToolMcpServer, type AppToolHandlers, type AppToolTaxonomy,
} from '@tangle-network/agent-app/tools'

const taxonomy: AppToolTaxonomy = { proposalTypes: [...], regulatedTypes: [...] }
const handlers: AppToolHandlers = { submitProposal, scheduleFollowup, renderUi, addCitation } // your DB ops

// 1. Sandbox MCP path — one route file per tool:
export const action = ({ request }) =>
  handleAppToolRequest(request, { tool: 'submit_proposal', handlers, taxonomy, verifyToken })

// 2. Per-turn MCP servers (spread into the agent profile's mcp map):
const mcp = { submit_proposal: buildAppToolMcpServer({ tool: 'submit_proposal', baseUrl, token, ctx, description }) /* … */ }

// 3. agent-runtime chat path (eval / non-sandbox) — advertise tools + execute:
runChatThroughRuntime({ /* … */ backend: makeBackend({ tools: buildAppToolOpenAITools(taxonomy) }),
  appToolExecutor: createAppToolRuntimeExecutor({ handlers, taxonomy, ctx, onProduced }) })
```

`insurance-agent` is the reference consumer; its `src/lib/.server/tools/*` is being refactored to delegate here.

## Why this exists

Each agent app re-implements the same plumbing (chat pipeline, approval queue, the structured side channel, vault, auth/RBAC, eval scaffold). That fork-duplication is why a single change — e.g. migrating the human-in-the-loop gate from fenced `:::proposal` blocks to validated tool calls — has to be redone in five apps. Lifting the shell here makes it a one-place change, propagated by a version bump.

## Develop

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

Build: tsup (ESM + d.ts). Tests: vitest. No upward deps on any product.
