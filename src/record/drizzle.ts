/**
 * Drizzle-backed substrate for the record module: the table factory
 * (`createRecordTable`) and the store (`createRecordStore`). Its own subpath
 * (`@tangle-network/agent-app/record/drizzle`) because every file here imports
 * `drizzle-orm` at module top — bundling them into `./record` would make the
 * optional peer a hard requirement for every record consumer.
 *
 * The pure `./record` leaf (entry vocabulary, canonical encoding, conflict
 * rule, fold) stays drizzle-free, so a browser surface that only renders a
 * review queue never pulls a database driver.
 */
export * from './drizzle/schema'
export * from './drizzle/store'
