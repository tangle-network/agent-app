# Resumable chat turns (don't lose a stream on disconnect)

When a model answers, it streams out in pieces. If the user's tab drops — or a
Worker restarts mid-turn — you don't want to lose the answer. This module buffers
every event as it's produced so a reconnecting client can replay the tail.

## ⚠️ First: is a live browser watching an INTERACTIVE sandbox turn? Then you don't need this.

**The `@tangle-network/sandbox` SDK already buffers + replays session streams —
but only the lane you drive the turn on.**
A production A/B (4 arms, sandbox.tangle.tools, SDK 0.12.0) measured it:

| turn driver | endpoint | raw turn events | delivered to a gateway client |
| --- | --- | --- | --- |
| `box.streamPrompt()` × 3 session-id strategies | `POST /agents/run/stream` | 71 / 527 / 408 | **0 / 0 / 0** |
| `box.session(id).sendMessage({ parts })` | `POST /agents/sessions/{id}/messages` | 297 | **297 / 297** |

So:

- **Interactive turn, browser attaching** — drive it on the message lane
  (`box.createSession({ sessionId, backend })` once, then
  `box.session(id).sendMessage({ parts })`) and let the tab connect with
  `box.mintScopedToken({ scope: 'session', … })` + `SessionGatewayClient`
  (`@tangle-network/sandbox/session-gateway`). **Do not hand-roll the buffer
  below over that.**
- **Worker holding the turn** — `box.streamPrompt()`, and resume with
  `box.streamPrompt('', { executionId, lastEventId })`: it replays strictly
  after the cursor and does not re-dispatch (measured over a SIGKILL: 0 lost,
  0 duplicated, 0 out-of-order, ids 1..517 contiguous). Still no buffer needed.
- **DETACHED / autonomous run a browser must tail** — you DO need this module.
  `dispatchPrompt({ detach: true })` and `driveTurn` call `streamPrompt`
  internally, so the run never reaches the gateway and no SDK primitive can
  show it to a tab. Use `runDetachedTurn` (`/chat-routes`) over a
  `TurnEventStore`.

**This module has exactly two niches**: the SANDBOX-FREE path (a browser or
edge copilot streaming the Tangle Router, or any OpenAI-compatible endpoint,
directly — the [`browser-copilot.md`](./browser-copilot.md) shape), and any
detached sandbox run that must be watchable live.

```
POST /chat/stream          → buffer the turn + stream live    (pump OR tap)
GET  /chat/stream/:turnId  → replayTurnEvents({ fromSeq }) → NDJSON tail
```

It is pure mechanism behind a storage seam — no peers. Storage is a
`TurnEventStore`; a D1 implementation and an in-memory one ship here.

## Do you need it?

| You're running… | Use this? |
| --- | --- |
| **Interactive sandbox turn, browser attaching** | **No** — drive it on the message lane (`box.session(id).sendMessage()`) and attach the tab with `box.mintScopedToken()` + `SessionGatewayClient`. The gateway delivered 297/297 frames on that lane. |
| **Interactive sandbox turn, worker consumes it** | **No** — `box.streamPrompt()` + `box.streamPrompt('', { executionId, lastEventId })` resumes losslessly. (A gateway client sees nothing on this lane, so if a second viewer must watch, move the turn to the message lane rather than buffering it.) |
| **Sandbox-free interactive turn** (browser/edge copilot on the Router directly) | **Yes** — there's no gateway; this is your resume mechanism. |
| **Autonomous / detached turn a browser must tail** (mission, queue, cron, inbound email) | **Yes** — `dispatchPrompt({ detach: true })` and `driveTurn` run on the lane the gateway cannot see, so the buffer is the only live path. Use `runDetachedTurn` (`/chat-routes`), which does exactly that bridge. |
| **Autonomous turn nobody watches** | **No** — `box.driveTurn()` (agent-app's `driveSandboxTurn`) ticked from a durable driver, or raw `dispatchPrompt({ detach: true })` + poll. Nothing to stream. |
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
import { handleChatTurn } from '@tangle-network/agent-runtime/durable'

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

## Retain only the replay window you need

Turn events are durable until the product removes them. Run the cleanup from a
scheduled worker after the durable assistant message is available:

```ts
const cutoff = Date.now() - 24 * 60 * 60 * 1000
const removed = await store.pruneTerminalTurns?.(cutoff)
await store.deleteTurn?.(turnId) // Explicit deletion removes events and status.
```

`pruneTerminalTurns` removes `complete` and `error` turns whose status timestamp
is strictly before the cutoff. It never removes a `running` turn, and it keeps
orphaned event rows because no status exists to prove that they are terminal.
The D1 implementation executes event and status deletion in one `batch()` so a
partial cleanup cannot be observed. A D1-like test driver without `batch()` is
rejected when either retention method is called. Both methods are optional on
`TurnEventStore`, so existing custom stores remain source-compatible.

## Status today

Shipped and ready, **not yet wired into any product** — adopt it the day you
want reconnect-without-loss. Nothing to run until then.
