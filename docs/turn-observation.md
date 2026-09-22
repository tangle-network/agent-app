# Observe a turn without owning its execution

`parseTurnObservation`, `observeTurnEvent` and `consumeTurnStream` are exported through the existing `/stream` subpath. They implement the native chat NDJSON read contract; they do not submit messages, approve interactions, cancel jobs, retry writes, or create an execution owner.

The API's `X-Turn-Id`/`turn` marker is a replay handle, not the client-generated message ID. Persist it separately. Live frames may be unsequenced. Only the replay's positive, contiguous `seq` values advance the resume cursor. Duplicate ordinals are ignored; gaps, malformed frames, changed stream identities and invalid saved checkpoints fail rather than silently dropping output. Canonical buffer statuses `complete` and `error` are terminal; `timeout`, `running`, `unknown` and EOF are not success. A later success does not erase an observed failure.

```ts
import { consumeTurnStream } from '@tangle-network/agent-app/stream'

await consumeTurnStream(response.body, {
  checkpoint: savedCheckpoint,
  commit: async update => {
    await saveEvidenceAndCheckpoint(update.event, update.checkpoint)
  },
})
```

The callback must durably commit evidence before acknowledging its cursor. If the process dies after appending evidence but before checkpointing, a caller may see that frame again and should use its replay ordinal when materializing results. An observer timeout must be separate from a user-authorized execution cancellation. Resume through GET of the retained replay handle, never by issuing another chat POST. A lost admission response with no trustworthy replay handle stays uncertain.

The frame-size option bounds one untrusted JSON line, not transcript length, token budget or job duration. UTF-8 boundaries, CRLF and a final line without newline are supported. Callers own authentication, network timeouts, private storage, redaction and verification of the resulting workspace/provider records.

## Server ownership is a separate contract

A buffer, cursor or `waitUntil` promise is not a durable job owner. Cloudflare HTTP Workers allow `waitUntil` for up to 30 seconds after the response completes or the client disconnects. Accepted long work needs the existing durable Workflow/SDK ownership and idempotent settlement, not a larger observation timeout.

`runDetachedTurnWorkflowTick` validates the SDK result inside `step.do` before it is committed. A malformed provider response can then be retried, rather than being replayed indefinitely from a poisoned step. A copied, frozen top-level admission payload prevents drive callbacks from changing session/turn identity between passes. Settlement remains caller-owned and must be idempotent; an external write may have succeeded before its step acknowledgement was lost.

The focused tests simulate successful-step replay and independently test read-side framing.
They do not establish deployed Workflow behavior, sandbox survival, or arbitrary-duration service limits.
Each product must verify its deployed completion path by leaving a running turn and checking the retained result.

Reference: https://developers.cloudflare.com/workers/platform/limits/ and the existing `src/preset-cloudflare/detached-turn-workflow.ts`.

## Exact completed-turn recovery

Use `readCompletedSandboxTurn` for the keyed result and completed message of one
session/turn. It never reads the session's latest aggregate result: that result
can belong to a newer turn by the time the request arrives. A healthy absent
read returns `null`; unavailable or inconsistent evidence without an exact
record throws and must be retried as a read, not interpreted as permission to
start another execution. Either independently exact record can still recover
the turn when the other read is unavailable.

`runDetachedTurn` preserves errors from status reads, completed-result reads,
buffer resets and terminal status writes. Re-streaming an existing running
buffer requires a successful `resetBuffer`. This is buffer integrity, not an
execution dispatcher: the supplied source must still attach to the original
execution. A completed buffer without either a retained result or its assistant
row is not reported as an empty success. Cached recovery keeps usage already
stored on that row when a newer exact receipt omits it; measured zero remains
zero and unknown usage is not synthesized.

## Native chat completion

Use `observeNativeCompletion` with `runNativeCompletionWorkflow` when another request dispatches the native execution.
The observer reads admitted execution records and never sends a prompt or cancels work.
It preserves partial output from failed turns and aggregates receipts in admission order.
Missing usage remains unknown.

Register the Workflow before native dispatch, using stable session, execution, and replay identities.
Then call `await args.handoffCompletion()` from the assembled route's producer.
That handoff stops request-owned transcript writes, terminal hooks, replay status writes, and lock release.
Live events can continue while the Workflow owns completion.
The default route retains its existing behavior when no handoff occurs.

```ts
await runNativeCompletionWorkflow({
  event,
  step,
  observe: async payload => observeNativeCompletion({
    source: await resolveSandbox(payload),
    admissionStore,
    executionId: payload.turnId,
    sessionId: payload.sessionId,
    turnId: payload.turnId,
    registeredAt: payload.registeredAt,
  }),
  prepare: prepareProductOutput,
  persistTranscript: persistStableAssistantRow,
  settle: settleProductRecords,
  finalizeBuffer: finishReplay,
  releaseLock: releaseProductLock,
})
```

Products own their storage, authorization, continuation policy, billing ownership, and file reconciliation.
Reserve each continuation atomically before dispatch and prevent new admissions after closure.
An expired owner lease may close only under the observer's terminal or absent-dispatch checks.
Use one product finalizer for live and recovered output, including successful files from failed executions.
Promote files before deciding whether an answer contains visible output.

`prepare` and `settle` run outside enclosing Workflow steps so products can compose named steps without nesting `step.do`.
Their effects must be idempotent.
The helper checkpoints transcript persistence, replay completion, and lock release.
Settlement may return a revised receipt when reconciliation discovers a terminal failure.
That receipt updates the assistant row before replay completion.
A rejected settlement leaves the lock held for recovery.
