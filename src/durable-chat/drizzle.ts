/**
 * `@tangle-network/agent-app/durable-chat/drizzle` — the production store behind
 * the durable plan and interaction ports.
 *
 * Subpath-only, and never re-exported from the package root: it imports the
 * optional `drizzle-orm` peer at module top, so a consumer that only wants the
 * pure `./durable-chat` protocol never pulls a database dependency.
 *
 * ```ts
 * import { drizzle } from 'drizzle-orm/d1'
 * import {
 *   createDurableChatTables,
 *   createDrizzleDurableChatStore,
 * } from '@tangle-network/agent-app/durable-chat/drizzle'
 *
 * const tables = createDurableChatTables()
 * const store = createDrizzleDurableChatStore({ db: drizzle(env.DB), tables })
 * ```
 *
 * Apply `DURABLE_CHAT_MIGRATION_SQL` (or the block it ships in the chat
 * template's migrations) before first use.
 */

export * from './drizzle/schema'
export * from './drizzle/store'
