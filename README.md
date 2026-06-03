# @tangle-network/agent-app

Shared **application-shell framework** for Tangle agent products (insurance, tax, legal, creative, gtm, agent-builder). The substrate packages (`@tangle-network/{sandbox, agent-runtime, agent-eval, agent-integrations, agent-knowledge, tcloud}`) are the *engine*; this package is the *shell* — the opinionated, reusable application layer those products currently fork-duplicate.

The goal: a product should `pnpm add @tangle-network/agent-app`, supply its domain seams (schema, prompt, taxonomy, persistence), and get the whole shell — instead of copy-forking another agent app and inheriting its bugs (the way insurance forked legal and inherited legal's IRS/FinCEN filing scripts).

Everything here is **domain-seamed**: the generic mechanism lives in the package; each product supplies callbacks/config for the domain-specific bits. The package imports no product code.

## Modules

| Subpath | Status | What it is |
|---|---|---|
| `@tangle-network/agent-app/tools` | ✅ **shipped + tested** | The structured agent→app tool side channel — `submit_proposal` (approval-gated), `schedule_followup`, `render_ui`, `add_citation`. OpenAI tool defs, MCP-server builder, HTTP route handler, agent-runtime executor, capability auth. Replaces brittle fenced `:::` blocks with validated tool calls. Seam: `AppToolHandlers` + `AppToolTaxonomy`. |
| `@tangle-network/agent-app/delegation` | ✅ **shipped + tested** | The agent-runtime "driven loop" MCP (`delegate_research` / `delegate_code` / `delegation_status` …) for multi-step work that runs to completion in its own agent-driver sandbox. Optional; opt in by spreading into the profile `mcp` map. |
| `@tangle-network/agent-app/tangle` | ▢ next | Tangle login (SSO) + the developer self-service **app-registration → broker-token** flow (wraps `@tangle-network/agent-integrations` `TangleAppsClient`: register app → consent → `sk-tan-broker-` token → hub exec). Provides a `verifyToken`/broker-bearer source the `/tools` auth seam consumes. |
| `@tangle-network/agent-app/runtime` | ▢ next | Adapter over `@tangle-network/agent-runtime`: the chat turn (`runChatThroughRuntime` shape) wired to the app tools + delegation + integration-invoke, with the readiness/knowledge seam generalized out of the legal/insurance fork. |
| `@tangle-network/agent-app/eval` | ▢ next | Generic eval scaffold over `@tangle-network/agent-eval`: the canonical runner + completion oracle + scoring rubric as a templated harness, with the persona/taxonomy/judge-rubric as seams. (Insurance's `tests/eval/canonical.ts` is the reference to generalize.) |

✅ = built, typechecked, unit-tested, builds. ▢ = designed, not yet built.

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
