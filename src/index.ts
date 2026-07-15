/**
 * @tangle-network/agent-app — shared application-shell framework for Tangle
 * agent products.
 *
 * First module: the structured agent→app tool side channel (`./tools`). More
 * shell layers (chat pipeline, approval queue, vault, eval scaffold) are lifted
 * here incrementally as products converge on them.
 */
export * from './tools/index'
export * from './tangle/index'
export * from './runtime/index'
export * from './eval/index'
export * from './knowledge/index'
export * from './knowledge-loop/index'
export * from './harness/index'
export * from './config/index'
export * from './preset-cloudflare/index'
export * from './billing/index'
export * from './preflight/index'
// `/chat-store`'s drizzle factory + store stay subpath-only (they import the
// optional drizzle-orm peer at module top); its pure pieces — the stored
// `parts` vocabulary, title derivation, input error — are safe here.
export * from './chat-store/core'
export * from './chat-store/parts'
export * from './crypto/index'
export * from './stream/index'
export * from './integrations/index'
export * from './interactions/index'
export * from './missions/index'
export * from './sandbox/index'
export * from './web/index'
export * from './redact/index'
export * from './assets/index'
export * from './theme/index'
// `/theme-contract` (the CI token-completeness checker) reads the filesystem
// (node:fs) — server-only, same as the other node-touching modules re-exported
// here. `/theme` itself stays browser-clean (it's in the browser-safe manifest).
export * from './theme-contract/index'
// `/app-auth` is intentionally NOT re-exported here: it imports the optional
// better-auth peer at module top (same rule as `/platform`, which stays
// subpath-only for its structural seams). `/chat-routes` likewise stays
// subpath-only — it imports the optional agent-runtime peer at module top;
// its browser-safe wire contract is re-exported via `/web-react`.
// `/web-react` and `/sequences-react` are intentionally NOT re-exported here:
// they need the optional react peer and would drag JSX into every root-entry
// consumer. `/sequences/drizzle` likewise stays subpath-only — it imports the
// optional drizzle-orm peer at module top.
export * from './trace/index'
export * from './sequences/index'
// `/design-canvas/drizzle` and `/design-canvas-react` are intentionally NOT
// re-exported here: drizzle imports the optional peer at module top; react and
// konva are optional peers pulled in only by the design-canvas-react subpath.
export * from './design-canvas/index'
