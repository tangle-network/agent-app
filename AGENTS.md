# agent-app — agent working notes

`@tangle-network/agent-app` is the shared **application-shell framework** for Tangle agent products. The substrate packages are the *engine*; this is the *shell* those products otherwise fork-duplicate. A reference consumer is **100% on agent-app** for shell mechanism.

## The one rule (this governs every change)

> **Does the capability make sense WITHOUT a specific app's tool side-channel / approval queue / chat route?**
> **YES → it's an ENGINE concern** → it belongs in `@tangle-network/agent-eval` / `agent-runtime` / `agent-integrations` / `tcloud` / `sandbox`. If it's not there yet, **contribute it down** (additive export). Do NOT reimplement it here.
> **NO → it's app-shell** → it belongs here.

Corollary — **extend, never duplicate.** Before writing anything that completes, scores, runs a loop, parses a tool name, or talks to a hub, check what the engines already export. We shipped a bug doing this: `eval` reimplemented `verifyCompletion`/`weightedComposite` that agent-eval already exports — now it re-exports them and keeps only the bridge. (`git log` "de-duplicate against agent-eval".)

## Invariants

1. **Engine = `peerDependency`, never a bundled `dependency`.** The product pins the engine version → no BOM lock, no forced fleet bumps. agent-integrations + agent-eval are peers; the consumer installs them.
2. **Compose by seam, not by import.** agent-app owns mechanism + control flow; the product supplies domain through typed config/callbacks (`AppToolHandlers`, `AppToolTaxonomy`, `verifyToken`, `streamTurn`, `executeToolCall`, `KeyProvisioner`/`WorkspaceKeyStore`/`KeyCrypto`, `apiKeyResolver`, `BrokerTokenMinter`). **Never import product code. Never bake a domain value** (a proposal type, a premium, a disclaimer, a rubric) — it's a parameter.
3. **Structural over hard-dep where possible.** `/tangle` and `/billing` take the tcloud client as a structural contract (no tcloud dep). Prefer that to a dep when the surface is small.
4. **Substrate-free is a feature.** `/runtime`, `/web`, `/crypto`, `/redact` import nothing — they're pure mechanism behind callback seams. Keep them that way.
5. **Additive subpaths.** New capability = new `./subpath` (entry in `tsup.config.ts` + `exports` in `package.json` + root barrel). Never a breaking change to an existing export.

## Module map

| Subpath | Owns (app-shell) | Composes (peer/structural) |
|---|---|---|
| `/tools` | structured agent→app side channel (`submit_proposal`/`schedule_followup`/`render_ui`/`add_citation`): OpenAI defs, MCP-server builder (`buildHttpMcpServer`/`buildAppToolMcpServer`), HTTP route handler, runtime executor, capability auth, `ToolInputError` | — |
| `/runtime` | `streamAppToolLoop`/`runAppToolLoop` (bounded turn tool-loop) + `resolveTangleModelConfig` + `toLoopEvents`/`createOpenAICompatStreamTurn` (sandbox-free browser/edge copilot adapter — OpenAI-compat stream → LoopEvents, fragmented tool-calls assembled) | ⚠️ turn-loop is a contribute-down candidate to agent-runtime; the OpenAI-compat adapter only maps stream shape (no HTTP client — see `examples/browser-copilot.md`) |
| `/eval` | `producedFromToolEvents` (side-channel→`RuntimeEventLike` bridge) + `createTokenRecallChecker` | **re-exports** agent-eval's `verifyCompletion`/`extractProducedState`/`weightedComposite`/`createLlmCorrectnessChecker` |
| `/integrations` | hub `/exec` client + `resolveIntegrationAction` + `invokeIntegrationHub` (wiring) | peer-dep `@tangle-network/agent-integrations` (the engine/catalog) |
| `/tangle` | app-registration consent URL + cached broker-token provider | structural `TangleAppsClient` (from agent-integrations) |
| `/billing` | per-workspace budget-capped key manager (mint/rotate/rollover/usage) | structural tcloud provisioner + store + crypto seams |
| `/delegation` | the agent-runtime driven-loop MCP server entry (opt-in) | — |
| `/crypto` `/web` `/redact` `/stream` | AES-GCM field crypto · web boundary utils (body/context/rate-limit/headers) · PII redaction · SSE normalization + turn identity | — |

## Agent-native principles (products on the sandbox)

The sandbox runs full agent harnesses — skills, tools, sub-agents, MCP, bash, python — invoked through prompts. Products built on agent-app coordinate UI, durability, approvals, and billing **around** the agent. They never do the agent's work for it, and agent-app must never make it easy to.

1. **Intelligence and tooling live in the agent; durability and money live in the platform.** Reasoning, tool selection, installation, evidence gathering, content production → a prompt to an agent session. Surviving restarts, gating spend, pausing for approval → platform code (product or this shell).
2. **Prompts state intents, never implementations.** No shell commands, CLI flags, or install scripts inside system prompts, plan steps, or directives. Name the outcome and the evidence path; the executing agent chooses tools at execution time.
3. **No domain logic in execution infrastructure.** Engines, dispatchers, and schedulers must not pattern-match intents or embed per-vertical scripts. Vertical knowledge belongs in prompt directives and product content, the layers the agent reads. (Shell corollary of the engine/shell rule: domain is a parameter, never baked.)
4. **Don't rebuild harness or platform primitives.** The sandbox SDK already provides durable *session* execution: `dispatchPrompt({ detach: true })` runs the turn server-side after the caller disconnects, `findCompletedTurn(turnId)` is the idempotent completion check, `_sessionStatus`/`_sessionResult` poll lifecycle, and the session gateway mints read-only JWTs so browsers attach to live streams without the product worker. Autonomous/queue work must dispatch detached and poll — never hold an SSE stream open in a worker to learn that a session finished. What the SDK does NOT provide is multi-step *orchestration* (sequencing, gates, budgets, schedules) — that is the legitimate product/shell layer.
5. **Gate actions, not mechanics.** Approvals attach to what an action does (spend, publish, vault writes) classified from intent — not to literal commands.

The test for new code: *"Could the agent in the sandbox do this itself if we told it the intent?"* If yes, write the prompt, not the wrapper.

## Develop

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm build
```
tsup (ESM + d.ts), vitest, tsc. Every change keeps tests green. **No `Co-Authored-By` / AI-attribution in commits** (repo-wide). Commit identity is the global git config (`Drew Stone <drewstone329@gmail.com>`) — never override it.

## When you add a module
1. Apply the rule above — confirm it's shell, not engine.
2. Domain-seam it (typed config; no product import).
3. Wire `tsup.config.ts` + `package.json` `exports` + `src/index.ts`.
4. Real tests (the seam exercised with a fake; the engine path verified against the real engine where it composes one).
5. Prove it on a reference consumer — it stays green.
