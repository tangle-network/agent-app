/**
 * Sequence timeline module: frame-accurate timeline model, the closed
 * operation union, the store seam, the validate/apply kernel, caption +
 * export builders, and the MCP tool surface.
 *
 * Drizzle-backed persistence (schema factory + store implementation) lives in
 * './drizzle' (`@tangle-network/agent-app/sequences/drizzle`) because it
 * imports `drizzle-orm` at module top — this barrel must stay importable for
 * consumers without that optional peer installed.
 */
export * from './model'
export * from './operations'
export * from './store'
export * from './validate'
export * from './apply'
export * from './exports'
export * from './captions'
export * from './mcp-tools'
export * from './mcp-handler'
export * from './mcp-entry'
