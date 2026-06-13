/**
 * Design-canvas module: scene document model, the closed operation union,
 * the store contract, validate/apply kernel, template helpers, export presets,
 * and the MCP tool surface + handler/entry factories.
 *
 * Drizzle-backed persistence (schema factory + store implementation) lives in
 * './drizzle' (`@tangle-network/agent-app/design-canvas/drizzle`) because it
 * imports `drizzle-orm` at module top — this barrel stays importable for
 * consumers without that optional peer installed.
 *
 * Konva and React are NOT imported here — all Konva-dependent code lives in
 * `@tangle-network/agent-app/design-canvas-react`.
 */
export * from './model'
export * from './operations'
export * from './store'
export * from './validate'
export * from './apply'
export * from './templates'
export * from './export-presets'
export * from './lint'
export * from './themes'
export * from './archetypes'
export * from './mcp-tools'
export * from './mcp-handler'
export * from './mcp-entry'
