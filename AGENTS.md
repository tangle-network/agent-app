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

> For the layered view (L0 foundation → L3 React surfaces), the dependency-direction rule, and a "where do I add X?" guide, see [`ARCHITECTURE.md`](./ARCHITECTURE.md). The table below is the per-subpath ownership detail.

| Subpath | Owns (app-shell) | Composes (peer/structural) |
|---|---|---|
| `/tools` | structured agent→app side channel (`submit_proposal`/`schedule_followup`/`render_ui`/`add_citation`): OpenAI defs, MCP-server builder (`buildHttpMcpServer`/`buildAppToolMcpServer`), HTTP route handler, runtime executor, capability auth, `ToolInputError` | — |
| `/runtime` | `streamAppToolLoop`/`runAppToolLoop` (bounded turn tool-loop) + `resolveTangleModelConfig` + `toLoopEvents`/`createOpenAICompatStreamTurn` (sandbox-free browser/edge copilot adapter — OpenAI-compat stream → LoopEvents, fragmented tool-calls assembled) | ⚠️ turn-loop is a contribute-down candidate to agent-runtime; the OpenAI-compat adapter only maps stream shape (no HTTP client — see `examples/browser-copilot.md`) |
| `/eval` | `producedFromToolEvents` (side-channel→`RuntimeEventLike` bridge) + `createTokenRecallChecker` | **re-exports** agent-eval's `verifyCompletion`/`extractProducedState`/`weightedComposite`/`createLlmCorrectnessChecker` |
| `/integrations` | hub `/exec` client + `resolveIntegrationAction` + `invokeIntegrationHub` (wiring) | peer-dep `@tangle-network/agent-integrations` (the engine/catalog) |
| `/interactions` | human-in-the-loop ask channel, both halves: the shared wire/persisted-part contract (`ChatInteraction`, part codecs, composer-as-answer routing, content-signature dedupe) + the server side — structural sidecar `/agents/sessions/{id}/interactions` client and `createInteractionAnswerRoute()` (list/answer endpoint factory: body validation, gone→410 mapping, duplicate-answer safety net, unblock verification, `resolveConnection` product seam) | peer `@tangle-network/agent-interface` (schema types only); connection is structural — no sandbox-SDK import. Server half must never reach client bundles (`tests/interactions-browser-safe.test.ts`) |
| `/plans` | browser-safe durable-plan chat projection: `plan.submitted` parser, persisted `type:'plan'` codec, stable transcript keys, follow-up turn ids, and monotonic status transitions | structurally byte-matches the durable plan returned by peer `@tangle-network/sandbox`'s `SandboxSession.plan()`; lifecycle and decisions remain SDK-owned |
| `/chat-routes` | the assembled server chat vertical (#188 Phase 1): `createChatTurnRoutes()` — body parse/validate → injected `authorize` seam → producer seam → turn-buffer tap wired BY DEFAULT → NDJSON `Response` + replay endpoint + composed `/interactions` answer endpoints + `/chat-store` persistence (user row on send, assistant row with parts/usage on completion); six optional product seams (`turnLock`/`contextGate`/`beforeTurn`/`onRawEvent` are `@experimental` — single-consumer, proven by gtm (#200), kept FLAT for back-compat; `lifecycle`/`heartbeat` are stable) — `turnLock` (single-flight acquire/release), `contextGate` (pre-producer domain-readiness short-circuit), `beforeTurn` (observe/augment producer input), `lifecycle` (deterministic start/complete/error telemetry, idempotent + settled even on a synchronous pre-stream throw), `heartbeat` (keepalive during silent producer waits), `onRawEvent` (raw producer-event tap) — plus `transformFinalText` (pre-persist redaction applied to BOTH the final-text scalar AND every persisted assistant TEXT part, so `/redact` closes the at-rest PII leak, not just the streamed scalar) and run-failure surfacing (`onTurnComplete` receives `failed`/`failureReason` from a terminal `error`/`session.run.failed` event so an errored turn is skipped for billing + rendered as an error row, never billed/marked-complete with empty text); `createSandboxChatProducer` (raw sandbox events → client vocabulary + persisted parts + usage receipt, non-renderable-ask auto-decline); `createUploadRoute` (sole consumer: the `--chat` scaffold — fleet apps keep their own durable-vault routes; multipart → inline `data:` part ≤700 KiB, else base64 write through a structural sandbox sink + path-ref part — the >1 MiB gateway cap makes the two-step mandatory); import-free `./wire` contract (`ChatTurnRequestPayload`, inline-part byte gate) re-exported via `/web-react`'s chat-stream | peer `@tangle-network/agent-runtime` (`handleChatTurn` IS the turn engine — zero loop logic here; subpath-only, not in the root barrel); composes `/stream`, `/chat-store`, `/interactions`, `/web`. Reference assembly: `examples/chat-app.md` |
| `/tangle` | app-registration consent URL + cached broker-token provider | structural `TangleAppsClient` (from agent-integrations) |
| `/billing` | per-workspace budget-capped key manager (mint/rotate/rollover/usage) | structural tcloud provisioner + store + crypto seams |
| `/preflight` | deploy-time secret-liveness probes: `runPreflight(probes)` → per-probe verdict + latency + overall pass/fail (any critical fail → fail); standard builders `routerChatProbe`/`sandboxAuthProbe`/`httpHeadProbe` (explicit config, read nothing global); `formatPreflightReport` table + the `agent-app-preflight` bin reading `preflight.config.mjs`. Binds at DEPLOY time (the one place with real secrets — CI can't hold them); failures name the exact secret to rotate | — (server-only; product declares probes from `process.env`) |
| `/missions` | durable multi-step mission orchestration: guarded status/step machine + cursor + cost ledger over a `MissionStorePort` (CAS updates → typed conflict, opaque `extras` insert passthrough for product columns), idempotent plan engine (cached-done short-circuit, cursor reconciliation, retryable-vs-deterministic failure, detached-session polling), budget/classification/volume gates that park as `waiting_approval`, `:::mission` parser, client-safe live-event reducer + the canonical `StepAgentActivity` per-step delegated-run lane (`step.updated` snapshot, latest-wins) | — (substrate-free; product supplies storage, `SandboxDispatch`, approvals port, `classifyStep`) |
| `/trace` | flow observability: FlowSpan/FlowTrace + ASCII waterfall/histogram renderers; mission trace bridge (`createMissionTraceContext`/`childSpanContext`/`traceEnv` — 32-hex/16-hex ids + the `TRACE_ID`/`PARENT_SPAN_ID` env pair agent-runtime's `readTraceContextFromEnv` inherits); delegation→FlowSpan converters (`delegationActivityToFlowSpans`, `loopTraceEventsToFlowSpans` over a structural `LoopTraceEventLike`, `composeMissionFlowTrace`, `stepActivityFlowTrace`) | — (pure data; id formats byte-match agent-runtime's OTLP export, no import) |
| `/web-react` | shared chat-shell + observability components: ModelPicker/EffortPicker/ChatMessages/RunDrillIn, `MissionActivityLane` (per-step delegated-run sub-rows → web waterfall), `AgentActivityPanel` (cross-context delegation surface over a `fetchActivity(cursor)` data port, missionRef link slot), `FlowWaterfall` + pure `waterfallLayout`/`mergeActivityPages` helpers, `InteractionQuestionCard`/`InteractionPlanCard` + `useChatInteractions`/`createInteractionAnswerSubmitter` (the client half of `/interactions`) | react peer; renders `/missions` lanes via `/trace` converters and `/interactions` asks via its contract |
| `/crypto` `/web` `/redact` `/stream` | AES-GCM field crypto · web boundary utils (body/context/rate-limit/headers) · PII redaction · SSE normalization + turn identity | — |
| `/theme` `/styles` `/tailwind-preset` | single design-token source for every React surface: `tokens.css` (`:root` + `[data-theme="dark"]`/`.dark`, shadcn channel triples with canvas/sequences `--bg-input`/`--text-primary`/`--border-default`/… aliases resolving to them), typed `AgentAppTheme` + `lightTheme`/`darkTheme`/`themeToCssVars`/`themeColor`, and a Tailwind preset mapping shadcn names (`bg-card`, `text-muted-foreground`…) to the vars. Consumers: `import '@tangle-network/agent-app/styles'` + add the preset. Enforced by `tests/theme/tokens-contract.test.ts` — every `var(--…)` a component references must be defined here, else it ships transparent. | — (pure CSS/data; no peer) |
| `/theme-contract` | node-only token-completeness checker consumers run in CI over THEIR OWN source (`checkThemeContract` + the `agent-app-theme-check` bin): a full `var(--…)` reference scan plus a check of the known-dangerous preset utilities (`surface-container*`/`card`/`popover`) against the shipped `tokens.css` + any extra app CSS — catches the invisible-popover/transparent-dropdown class. Split from `/theme` (which stays browser-clean) because it reads `fs`. Single source of truth for the token walk in `tokens-contract.test.ts`. | — (pure `fs` mechanism; no peer) |

## Agent-native principles (products on the sandbox)

The sandbox runs full agent harnesses — skills, tools, sub-agents, MCP, bash, python — invoked through prompts. Products built on agent-app coordinate UI, durability, approvals, and billing **around** the agent. They never do the agent's work for it, and agent-app must never make it easy to.

1. **Intelligence and tooling live in the agent; durability and money live in the platform.** Reasoning, tool selection, installation, evidence gathering, content production → a prompt to an agent session. Surviving restarts, gating spend, pausing for approval → platform code (product or this shell).
2. **Prompts state intents, never implementations.** No shell commands, CLI flags, or install scripts inside system prompts, plan steps, or directives. Name the outcome and the evidence path; the executing agent chooses tools at execution time.
3. **No domain logic in execution infrastructure.** Engines, dispatchers, and schedulers must not pattern-match intents or embed per-vertical scripts. Vertical knowledge belongs in prompt directives and product content, the layers the agent reads. (Shell corollary of the engine/shell rule: domain is a parameter, never baked.)
4. **Don't rebuild harness or platform primitives.** The sandbox SDK already provides durable *session* execution: `dispatchPrompt({ detach: true })` runs the turn server-side after the caller disconnects, `findCompletedTurn(turnId)` is the idempotent completion check, `_sessionStatus`/`_sessionResult` poll lifecycle, and the session gateway mints read-only JWTs so browsers attach to live streams without the product worker. Autonomous/queue work must dispatch detached and poll — never hold an SSE stream open in a worker to learn that a session finished. What the SDK does NOT provide is multi-step *orchestration* (sequencing, gates, budgets, schedules) — that is the legitimate product/shell layer.
5. **No text-block data channels.** Agent writes (proposals, tasks, records, plans) go through schema-validated tools that fail loud back to the model — never through `:::block` text conventions scraped from output after the fact (regex parsing drops malformed data silently). `:::` blocks may exist only as SYSTEM-authored render vocabulary: the platform writes them into persisted messages as UI card anchors; no prompt teaches an agent to author one. (Fleet retirement: creative-agent #299–#301 is the canonical pattern — tool + fail-loud validation + byte-compatible rows + system-side anchor.)
6. **Gate actions, not mechanics.** Approvals attach to what an action does (spend, publish, vault writes) classified from intent — not to literal commands.

### Choosing a session transport (product agent vs eval agent)

Three callers, three transports — picking wrong is how durability bugs and overbuilt workers happen:

| Caller | Transport | Why |
| --- | --- | --- |
| **Interactive product turn** (chat, copilot) | `streamPrompt` held open for the turn; session-gateway read JWT for the browser to attach directly | A user is watching; worker lifetime ≈ turn length. The gateway replays buffered events on reconnect, so a dropped tab or worker restart loses nothing. |
| **Autonomous product work** (missions, queues, crons, scheduled jobs) | `dispatchPrompt({ detach: true })` + poll (`findCompletedTurn` / `_sessionStatus`) from a durable driver (CF Workflows, DO alarm, queue consumer) | No consumer exists and workers die in minutes. The platform executes the turn server-side; deterministic session/turn ids make crash re-dispatch a lookup, not a second agent run. Never hold an SSE stream open in a worker to learn that a session finished. |
| **Eval agent** (agent-eval loops, self-improve, CI) | `streamPrompt` / `runLoop` in a long-lived process | The harness IS the consumer and outlives the run; durability machinery adds nothing — reproducibility comes from scenarios and seeds, and a failed run is re-run, not resumed. |

`agent-runtime` stays durability-free on purpose: it must run identically in a local eval process, CI, and a sandbox. Durable *session* execution is the sandbox platform's job; durable *orchestration* (sequencing, gates, budgets, schedules) is the product/shell layer above it.

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
