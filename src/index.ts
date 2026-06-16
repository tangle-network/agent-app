/**
 * @tangle-network/agent-app — shared application-shell framework for Tangle
 * agent products.
 *
 * First module: the structured agent→app tool side channel (`./tools`). More
 * shell layers (chat pipeline, approval queue, vault, eval scaffold) are lifted
 * here incrementally as products converge on them.
 */
export * from './tools/index'
export * from './delegation/index'
export * from './tangle/index'
export * from './runtime/index'
export * from './eval/index'
export * from './knowledge/index'
export * from './knowledge-loop/index'
export * from './harness/index'
export * from './config/index'
export * from './preset-cloudflare/index'
export * from './billing/index'
export * from './crypto/index'
export * from './stream/index'
export * from './integrations/index'
export * from './missions/index'
export * from './sandbox/index'
export * from './web/index'
export * from './redact/index'
export * from './assets/index'
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
