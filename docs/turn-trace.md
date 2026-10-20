# One trace per turn

Where a customer's wait goes: every turn records one trace whose child spans cover its wall time, on the Router lane and the sandbox lane.
`@tangle-network/agent-app/turn-trace` owns the recorder, the Router `Server-Timing` reader and the Intelligence sink (one OTLP POST per turn, in agent-runtime's attribute vocabulary; it imports no other package, because the agent-runtime root pulls the sandbox SDK's `viem` import into a Worker bundle).
`createChatTurnRoutes` owns the turn, so it creates the trace and records admission and persistence itself.

## The trace

The trace id is the turn's execution id with each character outside `[A-Za-z0-9_-]` replaced by `_` (`turnTraceId`), because the Router drops any other `x-tangle-trace-id`.
Every Router request and every Sandbox call of the turn sends that id, so a Router dispatch row, a Sandbox API record and the turn's spans join on one value.

```text
agent_app.turn                       wall time of the turn; coverage and time per kind as attributes
├─ admission.*                       parse, authorize, model_policy, prepare, lock_warm, history, lock, history_recheck, persist_user, gate, before_turn, stream_setup, produce
│  └─ admission.running_probe        under history: the turn buffer's running index, read only when it decides a retry
├─ model.call                        one per Router request
│  ├─ network                        wait for headers, less the Router's server time
│  ├─ router.pre_upstream            Server-Timing upstream_start
│  ├─ router.upstream_wait           Server-Timing upstream_headers
│  └─ model.stream                   headers to the end of the body
├─ tool.call                         an app tool, sandbox_exec or sandbox_run
│  ├─ sandbox.claim                  the box a tool call waited for
│  └─ sandbox.exec                   the command, sent with the turn's trace id
├─ sandbox.claim                     ensureWorkspaceSandbox: its steps are children (credentials, get_running or list_running, egress, liveness, finalize, resume, create, wait_running)
├─ sandbox.lease.*                   the foreground provisioning lease a product's single-flight takes: inspect, acquire, release
├─ sandbox.spend.*                   the spend seam around the claim: before_provision, observe
├─ sandbox.prompt                    the in-box lane
│  ├─ sandbox.transit                SDK, API, orchestrator and host hops that no sidecar phase holds
│  ├─ sidecar.<phase>                agent_run_start, harness_spawn, harness_ready, first_model_request, first_upstream_byte, first_text
│  └─ sandbox.generation             first visible text to the end; the box agent's tool.call spans are inside it
└─ persist.*                         the assistant row and the turn buffer
```

`summary.firstVisibleMs` (root attribute `tangle.turn.first_visible_ms`) is the latency headline: from the request to the first reasoning, tool activity or answer output the member can see, including admission and the box or Router.
`createChatTurnRoutes` marks it on either lane; a product that owns its turn calls `trace.markFirstVisible()` on its first visible output.
`summary.firstTextMs` (`tangle.turn.first_text_ms`) is the second line: request to first answer text. Its meaning is unchanged; reasoning and tools never mark first text.
The lifecycle's `firstVisibleMs` and `firstTextMs` start later, at `onTurnStart` after admission. Record both in `rollout_turn_timing`; the rollout store reports `first_visible_p50_ms` / `first_visible_p90_ms` alongside answer-only `first_words_p50_ms` / `first_words_p90_ms`.
For an existing timing table, apply `ROLLOUT_TURN_TIMING_FIRST_VISIBLE_MIGRATION_SQL` from `/rollout/d1` once through the product's migration runner before using the new writer. Existing rows stay NULL; a new table uses `ROLLOUT_TURN_TIMING_SCHEMA_SQL`.
`summary.d1Queries` (root attribute `tangle.turn.d1_queries`) counts round trips through `withD1LimitAlarms`: batch is one, each first/all/raw/run is one, including failures. Chat routes isolate the counter per turn through AsyncLocalStorage; custom turn owners pass their scoped counter to `createTurnTrace({ d1QueryCounter })`. Read [the wiring contract](../README.md#shared-turn-defaults) for runtime and observation boundaries.
`summary.coveragePct` is the share of the turn's wall time inside at least one child span.
`summary.byKind` credits each instant to the deepest open span's kind (`admission`, `router`, `model`, `network`, `tool`, `sandbox`, `persist`, `other`), so it sums to the covered time, and `largestGapMs` is the longest stretch with no span open.
A span records metadata only: ids, durations, status codes, model names and token counts; never a prompt, an answer or a tool argument.

## The claim of a reused box

A reuse asks the platform for the box this isolate used last under that name (`sandbox.ensure.get_running`), and lists every running box (`list_running`) only when that id is gone, stopped or renamed.
For ten minutes after a check passed on a box, the same reuse skips it: the exec probe (`liveness`), the egress read, the runtime environment push and the deferred-corpus marker read.
A request is not promised the isolate that served the last one (eight consecutive Legal turns found no check from the turn before), so the box id and its checks are also kept in the Workers Cache API under the box name (`SandboxRuntimeConfig.reuseState` replaces it; `null` keeps them in the isolate): one read when the isolate has not seen the box, a write only when a check changed.
The checks belong to the box's identity, its `startedAt` and `filesystemIncarnationId` (the Sandbox API reports no `startedAt` today); a box that is not running when read, a resume, a delete and a failed probe forget them.
A `strict` or `blocked` egress verdict stands in for the read only when the reuse sends the box no credentials: a changed runtime environment, or a shell `bootstrap`, waits for a fresh read.
The spend gate (`sandbox.spend.before_provision`) and the box report (`sandbox.spend.observe`) run when the exec probe runs, and before any create, resume or restart.
`sandbox.claim` carries `sandbox.probe_trusted` when the probe was skipped.
A product whose first call on that box fails calls `dropTrustedBox(box)`; `true` means the ensure had skipped the probe, so it ensures once more and the second ensure checks everything.
`streamSandboxPrompt` does this itself when a prompt fails before its first event.
`reuseWorkspaceSandbox` is the ensure that never creates, resumes, restarts or deletes; a product's single-flight passes it as `reuse`, so a turn on a running box takes no lease and an ensure that needs a lifecycle step takes it as before.

## Wiring a product

1. `createChatTurnRoutes` exports every turn by default, from agent-app 0.60.221: with no `turnTrace` option its sink is `createIntelligenceTurnTraceSink({ project: projectId })`. Pass `turnTrace: { labels }` to label the root span, or `turnTrace: { sink, labels }` to send the trace elsewhere; `turnTrace: false` is the only opt-out, and `agent-app-signoff defaults` fails it until the app's `signoff.config.mjs` gives the reason. Every turn also writes one `agent_app_turn_trace` JSON log line (`firstVisibleMs`, `firstTextMs`, `coveragePct`, `byKind`, `largestGapMs`, `toolCalls`, `otlpTraceId`), so a host's Workers Logs hold the numbers without Intelligence access. The sink reads the Sandbox product key from the first of `SANDBOX_PRODUCTION_API_KEY`, `TCLOUD_SANDBOX_API_KEY` and `SANDBOX_API_KEY` that is set (Legal's Worker `TANGLE_API_KEY` was refused with HTTP 401, so a refusal is a console warning, not silence), and every failure (no key, a non-2xx answer, a rejected span) is a console warning unless `onError` takes it. The route runs the sink under `waitUntil` after the lifecycle hooks and after the turn lock is released, so a slow collector never holds the next send; `lifecycle.onTurnComplete` and `onTurnError` also receive `trace` (the summary). Follow-up work that only decorates a finished answer belongs in `lifecycle.afterSettle`, which runs under `waitUntil` once the assistant row is persisted and the lock is released: Legal's model-written checklist moved there from the producer's stream, where it held the lock for 8.8 to 19.6 s after the answer on 2026-10-19. That work records its own trace with `createTurnTrace` and sends it to the same sink, because this turn's trace has ended.
2. Pass `args.trace` to what the turn runs: `createRouterTurnProducer({ trace })` or `runRouterTurn({ trace })`, `streamSandboxPrompt(..., { trace })` and `ensureWorkspaceSandbox(..., { trace })`. A product that calls `box.streamPrompt` itself sends `traceId: trace.traceId` with the prompt and wraps the stream in `traceSandboxPromptEvents`. A call that gets no trace records nothing, and the turn's coverage says so.
3. A product that owns its turn without `createChatTurnRoutes` (a Durable Object turn) calls `createTurnTrace({ startedAt, executionId })`, records its own admission spans with `trace.record`, passes `trace` to `runRouterTurn`, and sends `trace.finish()` to the same sink.

Admission's serial reads are the history, the turn lock, the history recheck under the lock, and the user-row insert.
`admission.lock_warm` runs alongside the history read and ends when the lock's Durable Object answers; on a thread's first turn it holds that object's creation, which `admission.lock` then waits out.
The running-index read under `admission.history` runs only when its answer can change the turn: no client `turnId`, an assistant row trailing the thread, and the user row behind it repeating this content.
`produce` and the seams see `userMessageInserted: true` when this turn's insert created `userMessageId`, so a gate that refuses an already-answered retry skips its own read for a fresh row.

`afterAuthorize` starts a turn's box, keys and session as soon as `authorize` and the model policy admit it, so `sandbox.acquire` begins beside `admission.history` and the lock instead of after `admission.produce`.
The work it starts is never awaited by the route; a turn that ends before `produce` (a held lock, a changed history, a gate's answer) calls the release function the seam returned.

`authorize` receives the turn's `trace` and the `admission.authorize` span, and `beforeTurn` receives the `admission.before_turn` span as its second argument; a product records its own steps with `trace.measure(name, 'admission', work, undefined, span)` so each wait inside the seam is named and nested.

A turn handed to a durable owner with `handoffCompletion` ends its trace when this request's live projection ends, and the route exports it then (`tangle.turn.handed_off`), failed only when the projection saw an error; the owner settles everything else and never needs `args.trace`. A `contextGate` that answers `{ proceed: 'handoff' }` ends the trace at the gate the same way.
Sandbox SDK 0.62.2 sends `traceId` on `exec`; an older SDK ignores the field, and the prompt path has sent `traceId` since 0.60.

## Reading a turn

One id finds the turn in every store.
The trace id is `turnTraceId(executionId)`; the OTLP trace id Intelligence stores it under is `otlpTraceId(traceId)`.

| Where | How to read it |
|---|---|
| The turn response | `Server-Timing` on a turn sent without the progress-first header: `admission` (request to stream) and each `admission.*` span in start order, so `curl -sD - -o /dev/null` names where admission went; a progress-first stream reads the same spans from the sink |
| Inside the turn | `args.trace.spans()` returns the spans recorded so far, so a product's own log line can carry the route's admission steps |
| Tangle Intelligence (spans) | `GET /v1/traces/<otlpTraceId>/spans`; the root span `agent_app.turn` carries `tangle.trace_id`, `tangle.turn.coverage_pct`, `tangle.turn.wall_ms` and `tangle.turn.<kind>_ms` |
| Router dispatch audit row | `GET /api/admin/provider-dispatches?trace_id=<traceId>` (the admin-cli service identity); every model request of the turn, and every model call the box agent made, carries it |
| Hospitality | the turn's `web_turn_timing.record` JSON (`traceId`, `trace`) and its `hospitality_web_turn_timing` line |
| Workers Logs | the `agent_app_turn_trace` line every `createChatTurnRoutes` turn writes: `project`, `executionId`, `otlpTraceId`, `failed`, `handedOff`, then the summary (`firstVisibleMs`, `firstTextMs`, `wallMs`, `coveragePct`, `largestGapMs`, `byKind`, `modelCalls`, `toolCalls`) |
| Legal | the `legal_turn_trace` log line (wall time, `coveragePct`, `byKind`, `largestGapMs`) |

## Limits

- A trace is exported when the route's drain finishes, or for a handed-off turn when its live projection ends. A host that cancels the invocation first loses it: Legal's sandbox lane turn that outlived its invocation (330 s on 2026-10-19, `waitUntil() tasks did not complete ... cancelled`) exported nothing, and no lifecycle hook ran for it either.
- `sandbox_exec` and the sandbox prompt are timed from this side. The SDK's `onTiming` is per client and its entries carry no trace id, so a tool call's network and server time are not split yet; `sdk.request` timing needs `traceId` on `SdkTimingEntry` in the Sandbox SDK.
- Coverage counts any span, including one a product names `other`. A product that does not pass `args.trace` to its producers shows a low coverage rather than a made-up span.
