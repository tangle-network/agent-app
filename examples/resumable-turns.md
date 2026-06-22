# Resumable chat turns (don't lose a stream on disconnect)

When a model answers, it streams out in pieces. If the user's tab drops — or a
Worker restarts mid-turn — you don't want to lose the answer. This module buffers
every event as it's produced so a reconnecting client can replay the tail.

## ⚠️ First: are you on the sandbox? Then you almost certainly DON'T need this.

**The `@tangle-network/sandbox` SDK already buffers + replays session streams.**
`streamPrompt` / `dispatchPrompt` buffer events server-side; a reconnecting
client replays with `lastEventId` (the `Last-Event-ID` header), and
`findCompletedTurn` is the idempotent completion check. Both gtm-agent and
creative-agent already use this — **do not hand-roll the buffer below over a
sandbox session.** See the `sandbox-sdk-integration` guidance.

**This module is the resume story for the SANDBOX-FREE path only** — a browser or
edge copilot streaming the Tangle Router (or any OpenAI-compatible endpoint)
directly, where there is no sandbox session gateway to replay for you (the
[`browser-copilot.md`](./browser-copilot.md) shape). That's the whole niche.

```
POST /chat/stream          → buffer the turn + stream live    (pump OR tap)
GET  /chat/stream/:turnId  → replayTurnEvents({ fromSeq }) → NDJSON tail
```

It is pure mechanism behind a storage seam — no peers. Storage is a
`TurnEventStore`; a D1 implementation and an in-memory one ship here.

## Do you need it?

| You're running… | Use this? |
| --- | --- |
| **Sandbox-backed turn** (most products) | **No** — the SDK gateway already buffers + replays (`streamPrompt` + `lastEventId`). Use that. |
| **Sandbox-free interactive turn** (browser/edge copilot on the Router directly) | **Yes** — there's no gateway; this is your resume mechanism. |
| **Autonomous turn** (mission, queue, cron) | Prefer `dispatchPrompt({ detach: true })` + poll. Buffer only if you also stream it to a watcher AND aren't sandbox-backed. |
| **Eval / CI** (long-lived process) | **No** — the harness is the consumer and outlives the run; a failed run is re-run, not resumed. |

## Pick a transport — who owns the producer?

The buffering core is the same; the only question is whether **you** iterate the
stream or the **engine** does and only hands you a per-event callback.

### A. You own an `AsyncIterable` → `pumpBufferedTurn`

```ts
import { pumpBufferedTurn, createD1TurnEventStore, coalesceChatStreamEvents } from '@tangle-network/agent-app/stream'

const store = createD1TurnEventStore(env.DB)
// Drive to completion regardless of the client. Hand the promise to
// ctx.waitUntil so a disconnect can't kill the turn.
ctx.waitUntil(pumpBufferedTurn({
  source: myEventStream,          // AsyncIterable<ChatStreamEvent>
  store,
  turnId,
  scopeId: threadId,              // optional — enables listRunning() rediscovery
  coalesce: coalesceChatStreamEvents,
  write: (line) => sse.write(line), // best-effort live delivery; throwing ≠ stop
}))
```

### B. The engine owns iteration (agent-runtime `handleChatTurn`) → `createBufferedTurnTap`

`handleChatTurn` owns its producer loop and only exposes `hooks.onEvent`. The
tap consumes that push hook — no engine change, durability stays in the shell.

```ts
import { createBufferedTurnTap, createD1TurnEventStore, coalesceChatStreamEvents } from '@tangle-network/agent-app/stream'
import { handleChatTurn } from '@tangle-network/agent-runtime'

const tap = createBufferedTurnTap({
  store: createD1TurnEventStore(env.DB),
  turnId,
  scopeId: threadId,
  coalesce: coalesceChatStreamEvents,
  write: (line) => sse.write(line),
})

const result = handleChatTurn({ identity, hooks: { onEvent: tap.onEvent, /* …your other hooks */ } })
try {
  await result.finished
  await tap.done('complete')      // final flush + mark complete
} catch (err) {
  await tap.done('error')         // flush what was produced, mark error
  throw err
}
```

> Use `coalesceChatStreamEvents` for agent-runtime's `message.part.updated`
> stream and `coalesceDeltas` (the default) for the tool-loop's text/reasoning
> deltas. Without the right coalescer, every per-token delta persists as its own
> row. Both are concatenation-preserving — replay reproduces the identical text.

## Reconnect: replay the tail

```ts
import { replayTurnEvents } from '@tangle-network/agent-app/stream'

// GET /chat/stream/:turnId?fromSeq=NN — yields buffered rows after fromSeq, then
// follows a still-running turn until it completes/errors/times out, ending with
// a {seq:-1, …turn_status…} marker so the client knows why the stream ended.
for await (const row of replayTurnEvents({ store, turnId, fromSeq })) sse.write(row.event)
```

Lost the `turnId` on reload? If you passed a `scopeId`, find the in-flight turn:

```ts
const [running] = (await store.listRunning?.(threadId)) ?? []   // newest first
if (running) /* replay it */
```

## The migration (the one setup step)

The D1 store needs its tables. Add to your migrations:

```ts
import { TURN_EVENTS_MIGRATION_SQL, TURN_STATUS_SCOPE_MIGRATION_SQL } from '@tangle-network/agent-app/stream'
```

- **`TURN_EVENTS_MIGRATION_SQL`** — creates `turn_events` + `turn_status` (with
  the `scopeId` column and its index). Run it on any new deployment.
- **`TURN_STATUS_SCOPE_MIGRATION_SQL`** — `ALTER TABLE turn_status ADD COLUMN
  scopeId TEXT`. Run **only** on a deployment whose `turn_status` predates
  `scopeId`/`listRunning`. New deployments already have the column.

No D1? `createMemoryTurnEventStore()` satisfies the same interface for tests and
keyless local dev.

## Status today

Shipped and ready, **not yet wired into any product** — adopt it the day you
want reconnect-without-loss. Nothing to run until then.
