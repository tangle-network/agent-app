# One trace per turn

Where a customer's wait goes: every turn records one trace whose child spans cover its wall time, on the Router lane and the sandbox lane.
`@tangle-network/agent-app/turn-trace` owns the recorder, the Router `Server-Timing` reader and the Intelligence sink (one OTLP POST per turn, in agent-runtime's attribute vocabulary; it imports no other package, because the agent-runtime root pulls the sandbox SDK's `viem` import into a Worker bundle).
`createChatTurnRoutes` owns the turn, so it creates the trace and records admission and persistence itself.

## The trace

The trace id is the turn's execution id with each character outside `[A-Za-z0-9_-]` replaced by `_` (`turnTraceId`), because the Router drops any other `x-tangle-trace-id`.
Every Router request and every Sandbox call of the turn sends that id, so a Router dispatch row, a Sandbox API record and the turn's spans join on one value.

```text
agent_app.turn                       wall time of the turn; coverage and time per kind as attributes
├─ admission.*                       parse, authorize, prepare, history, lock, persist_user, gate, before_turn, stream_setup, produce
├─ model.call                        one per Router request
│  ├─ network                        wait for headers, less the Router's server time
│  ├─ router.pre_upstream            Server-Timing upstream_start
│  ├─ router.upstream_wait           Server-Timing upstream_headers
│  └─ model.stream                   headers to the end of the body
├─ tool.call                         an app tool, sandbox_exec or sandbox_run
│  ├─ sandbox.claim                  the box a tool call waited for
│  └─ sandbox.exec                   the command, sent with the turn's trace id
├─ sandbox.claim                     ensureWorkspaceSandbox: its steps are children (credentials, list_running, finalize, resume, create, wait_running)
├─ sandbox.prompt                    the in-box lane
│  ├─ sandbox.transit                SDK, API, orchestrator and host hops that no sidecar phase holds
│  ├─ sidecar.<phase>                agent_run_start, harness_spawn, harness_ready, first_model_request, first_upstream_byte, first_text
│  └─ sandbox.generation             first visible text to the end; the box agent's tool.call spans are inside it
└─ persist.*                         the assistant row and the turn buffer
```

`summary.coveragePct` is the share of the turn's wall time inside at least one child span.
`summary.byKind` credits each instant to the deepest open span's kind (`admission`, `router`, `model`, `network`, `tool`, `sandbox`, `persist`, `other`), so it sums to the covered time, and `largestGapMs` is the longest stretch with no span open.
A span records metadata only: ids, durations, status codes, model names and token counts; never a prompt, an answer or a tool argument.

## Wiring a product

1. `createChatTurnRoutes({ turnTrace: { sink: createIntelligenceTurnTraceSink({ project, apiKey }), labels } })`. The route runs the sink under `waitUntil` after the lifecycle hooks and after the turn lock is released, so a slow collector never holds the next send; `lifecycle.onTurnComplete` and `onTurnError` also receive `trace` (the summary).
2. Pass `args.trace` to what the turn runs: `createRouterTurnProducer({ trace })` or `runRouterTurn({ trace })`, `streamSandboxPrompt(..., { trace })` and `ensureWorkspaceSandbox(..., { trace })`. A product that calls `box.streamPrompt` itself sends `traceId: trace.traceId` with the prompt and wraps the stream in `traceSandboxPromptEvents`. A call that gets no trace records nothing, and the turn's coverage says so.
3. A product that owns its turn without `createChatTurnRoutes` (a Durable Object turn) calls `createTurnTrace({ startedAt, executionId })`, records its own admission spans with `trace.record`, passes `trace` to `runRouterTurn`, and sends `trace.finish()` to the same sink.

A turn handed to a durable owner with `handoffCompletion` is not exported by the route; that owner finishes `args.trace`.
Sandbox SDK 0.62.2 sends `traceId` on `exec`; an older SDK ignores the field, and the prompt path has sent `traceId` since 0.60.
