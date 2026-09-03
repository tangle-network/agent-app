/**
 * `/turn-stream` — shared durable turn replay/broadcast/lock on a Cloudflare
 * Durable Object (issue #221): the graduation of `createChatTurnRoutes`'
 * `turnStore` seam from "bring your own DO" to a real implementation, plus
 * the dual-scope single-flight turn lock and the live-viewer WebSocket
 * channel every fleet app was hand-rolling.
 *
 * Subpath-only and server-only (like `/chat-routes`): never re-exported from
 * the root barrel, never reachable from a client bundle. Cloudflare is
 * STRUCTURAL throughout — no `cloudflare:workers` import; a product binds
 * the DO by re-exporting {@link TurnStreamDO} from its worker entry and
 * declaring it in wrangler.
 *
 * Layout:
 *   ./core     — pure segment/lock/wire logic (unit-testable)
 *   ./do       — the DO transport shell + product extension seams
 *   ./adapters — turnStore + turnLock seam implementations, broadcast
 *                helpers, WS upgrade forwarder
 *   ./memory   — in-process harness for tests and keyless local dev
 *
 * What stays product-side, on purpose: WHICH scope a turn locks on, the
 * sandbox/session probes for stale-lock recovery, viewer authorization, and
 * any post-turn machinery that defers a lock release (the DO's protected
 * seams exist for exactly that).
 *
 * ── What is still the right answer here, and what is not ─────────────────
 *
 * A production A/B (4 arms, sandbox.tangle.tools, SDK 0.12.0) showed that a
 * browser attached to the sandbox session gateway sees a turn only when the
 * turn is driven on the session-MESSAGE lane
 * (`box.session(id).sendMessage()` → 297 of 297 frames delivered), never on
 * the run/stream lane (`box.streamPrompt()` → 0 of 71, 0 of 527, 0 of 408
 * across three session-id strategies). `./core`'s header carries the full
 * table.
 *
 * KEPT — no SDK primitive replaces these:
 *   • the dual-scope single-flight TURN LOCK (`createDurableTurnLock`,
 *     `reconcileStaleDurableTurnLock`) — the gateway is a read-only fanout
 *     and ships no admission control;
 *   • the per-workspace SIGNALS (`thread.created`, `thread.activity`, plus
 *     `productSyncEvents`) — the gateway is per-session;
 *   • the durable TURN-EVENT rows + running-turn index
 *     (`createDurableObjectTurnEventStore`) that `runDetachedTurn` streams
 *     into — stream/dispatch detached runs (`dispatchPrompt({ detach: true })`,
 *     `streamPrompt`) do not reach the gateway on the measured path. Sandbox
 *     0.37 `driveTurn` uses the session message lane and is gateway-visible
 *     by SDK contract. Autonomous stream/dispatch work a browser must tail
 *     still needs the durable rows.
 *
 * DEPRECATED — duplicates the SDK:
 *   • the interactive per-turn REBROADCAST/replay on the thread channel
 *     (`broadcastTurnStreamEvent` + the segment functions in `./core`).
 *     Sandbox products: drive on the message lane and attach the tab with
 *     `box.mintScopedToken({ scope: 'session' })` + `SessionGatewayClient`;
 *     resume a worker-side read with
 *     `box.streamPrompt('', { executionId, lastEventId })`, which replays
 *     strictly after the cursor without re-dispatching.
 *
 * Nothing is removed: these are published exports and unknown consumers may
 * hold them. Removal is a major-version change.
 */

export * from './core'
export * from './do'
export * from './adapters'
export * from './memory'
