/**
 * `@tangle-network/agent-app/record` — the source-cited, reviewable,
 * supersedable entry store, minus the database.
 *
 * This leaf is import-free: types, the key sentinels, canonical value
 * encoding, consumer-supplied validation, the conflict rule, and the pure
 * fold. A browser surface rendering a review queue and a worker writing rows
 * share exactly this vocabulary.
 *
 * The drizzle table factory and the store live behind
 * `@tangle-network/agent-app/record/drizzle`, because they import `drizzle-orm`
 * at module top and it is an optional peer.
 */

export * from './model'
export * from './fold'
export * from './ulid'
