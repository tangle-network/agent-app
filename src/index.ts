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
export * from './object-store/index'
// `/chat-store`'s drizzle factory + store stay subpath-only (they import the
// optional drizzle-orm peer at module top); its pure pieces — the stored
// `parts` vocabulary, title derivation, input error — are safe here.
export * from './chat-store/core'
export * from './chat-store/parts'
export * from './crypto/index'
export * from './stream/index'
export * from './integrations/index'
export * from './interactions/index'
export * from './plans/index'
export * from './durable-chat/index'
export * from './missions/index'
export * from './work-product/index'
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
// consumer.
export * from './trace/index'
// `/sequences` and `/design-canvas` are app-specific FEATURE surfaces (timeline
// editing, a design canvas), not shell mechanism every product wants — so they
// are NOT re-exported from the root. Import them explicitly when a product opts
// in: `@tangle-network/agent-app/sequences`, `@tangle-network/agent-app/design-canvas`.
// This keeps the root entry to shared mechanism instead of every product's
// features. (Their `/drizzle` + `-react` variants were already subpath-only for
// the optional drizzle / react / konva peers.)
