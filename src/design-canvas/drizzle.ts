/**
 * Drizzle-backed persistence for the design-canvas module: the table factory
 * and the `SceneStore` implementation. Its own subpath
 * (`@tangle-network/agent-app/design-canvas/drizzle`) because both files
 * import `drizzle-orm` at module top — bundling them into `./design-canvas`
 * would make the optional peer a hard requirement for every canvas consumer.
 */
export * from './schema'
export * from './drizzle-store'
