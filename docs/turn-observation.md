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

The focused tests simulate successful-step replay and independently test read-side framing. They do not establish deployed Workflow behavior, sandbox survival, arbitrary-duration service limits, or a product's adoption of durable settlement. GTM's hosted recorder consumes the read-side helpers; GTM still needs a durable owner for its completion path before claiming browser-independent completion.

Reference: https://developers.cloudflare.com/workers/platform/limits/ and the existing `src/preset-cloudflare/detached-turn-workflow.ts`.
