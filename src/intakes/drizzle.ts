/**
 * Drizzle-backed substrate for the intakes module: the table factory
 * (`createIntakeTables`, with an OPTIONAL `workspaceTable`) and the per-scope
 * store (`createUserIntakeStore`, `createProjectIntakeStore`). Its own subpath
 * (`@tangle-network/agent-app/intakes/drizzle`) because every file here imports
 * `drizzle-orm` at module top — bundling them into `./intakes` would make the
 * optional peer a hard requirement for every intakes consumer.
 *
 * The pure `./intakes` leaf (question-graph model + completion algebra) stays
 * drizzle-free, so an app that imports only `./intakes` (or only `.`) never
 * pulls drizzle.
 */
export * from './drizzle/schema'
export * from './drizzle/store'
