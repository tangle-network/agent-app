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
 */

export * from './core'
export * from './do'
export * from './adapters'
export * from './memory'
