/**
 * `/chat-routes` — the assembled server chat vertical (issue #188 Phase 1).
 *
 * Subpath-only (NOT re-exported from the root barrel): `turn-routes` imports
 * the optional `@tangle-network/agent-runtime` peer at module top, same rule
 * as `/app-auth`. The browser-safe wire contract lives in `./wire` and is
 * re-exported through `/web-react`'s chat-stream glue.
 */

export * from './wire'
export * from './turn-routes'
export * from './sandbox-producer'
export * from './durable-projection'
export * from './upload'
