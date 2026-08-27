/**
 * Drizzle schema factory for the chat thread/message tables — the same
 * injection pattern as `createTeamTables`: the product owns the workspace
 * table; the factory wires the thread FK into it so the whole graph lives in
 * one drizzle schema with real cascade semantics. Column names, types,
 * defaults, enums, and indexes mirror legal's and gtm's hand-rolled `thread`/
 * `message` tables so a product with those tables adopts the factory without
 * rewriting rows; `tablePrefix` covers products that namespace (tax's
 * `chat_messages` style).
 *
 * The core is the superset the three products agree on. Divergences dropped,
 * and why:
 * - `thread.status` ('active'|'archived', legal+gtm) — archive semantics
 *   diverge (tax uses `archivedAt`); product-domain lifecycle → extra column.
 * - `thread.scopeKind`/`scopeKey`/`harness` (gtm) — artifact anchoring and
 *   harness pinning are product-domain → extra columns.
 * - tax's `tax_sessions` session columns (`taxYear`, `projectRef`,
 *   `agentSessionId`, `agentRuntime`, `agentHarness`, `profile`, `error`,
 *   `userId`) — sandbox-session state, not chat state → extra columns.
 * - `message.toolInput`/`toolOutput` (legal+gtm) — duplicate of the tool
 *   part's `state.input`/`state.output` inside `parts` (the shape `/stream`'s
 *   `normalizePersistedPart` owns); keeping both invites drift.
 * - `message.vaultFiles` (legal+gtm) — vault is product-domain → extra column.
 * - tax's re-declared `turn_events`/`turn_status` DDL — deliberately NOT here;
 *   `/stream`'s turn-buffer owns that DDL (`TURN_BUFFER_D1_SCHEMA_SQL`).
 *
 * Kept beyond the intersection: tax's per-message `model`/`inputTokens`/
 * `outputTokens`, extended to the full usage receipt the harness actually
 * reports in `step-finish` parts (`tokens {input, output, reasoning,
 * cache{read, write}}` + `cost`) — see `./parts`.
 *
 * `threadExtraColumns`/`messageExtraColumns` merge product columns into the
 * table definitions (the `/missions` opaque-extras pattern: the store writes
 * `extras` values verbatim in the SAME insert statement and never reads,
 * validates, or defaults them).
 *
 * SERVER-side module (D1/libsql/better-sqlite3 behind a worker or server
 * route) — but free of `node:` builtins on purpose: D1 workers have none.
 */

import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteColumn, AnySQLiteTable, SQLiteColumnBuilderBase } from 'drizzle-orm/sqlite-core'
import type { ChatMessagePart } from './parts'

/** A product table referenced by FK — only the `id` column is touched. */
export type ChatParentTable = AnySQLiteTable & { id: AnySQLiteColumn }

/** Define options to customize chat thread and message table creation including workspace and naming prefixes */
export interface CreateChatTablesOptions<
  TThreadExtras extends Record<string, SQLiteColumnBuilderBase> = {},
  TMessageExtras extends Record<string, SQLiteColumnBuilderBase> = {},
> {
  /** The product's workspace table — threads reference `workspaceTable.id`
   *  with cascade. Omitted: `workspace_id` stays a plain indexed text column
   *  (products whose tenant table lives in another database). */
  workspaceTable?: ChatParentTable
  /** Prefixes table AND index names (`'chat_'` → `chat_thread`,
   *  `idx_chat_thread_workspace`) for products that namespace chat tables in a
   *  shared database. Default: unprefixed `thread`/`message` (legal/gtm row
   *  compatibility). */
  tablePrefix?: string
  /** Product columns merged into the thread table (the `/missions` extras
   *  pattern) — e.g. a `status` lifecycle enum or gtm's scope columns. */
  threadExtraColumns?: TThreadExtras
  /** Product columns merged into the message table — e.g. legal's
   *  `vault_files`. */
  messageExtraColumns?: TMessageExtras
}

const hexId = () => text('id').primaryKey().default(sql`(lower(hex(randomblob(16))))`)

const createdAt = () => integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)

const updatedAt = () => integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)

/** Build chat-related SQLite tables with customizable thread and message columns */
export function createChatTables<
  TThreadExtras extends Record<string, SQLiteColumnBuilderBase> = {},
  TMessageExtras extends Record<string, SQLiteColumnBuilderBase> = {},
>(options: CreateChatTablesOptions<TThreadExtras, TMessageExtras> = {}) {
  const { workspaceTable, tablePrefix = '' } = options
  const threadExtras = options.threadExtraColumns ?? ({} as TThreadExtras)
  const messageExtras = options.messageExtraColumns ?? ({} as TMessageExtras)

  const threads = sqliteTable(`${tablePrefix}thread`, {
    id: hexId(),
    workspaceId: workspaceTable
      ? text('workspace_id').notNull().references(() => workspaceTable.id, { onDelete: 'cascade' })
      : text('workspace_id').notNull(),
    title: text('title').notNull(),
    category: text('category'),
    isPinned: integer('is_pinned', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ...threadExtras,
  }, (table) => [
    index(`idx_${tablePrefix}thread_workspace`).on(table.workspaceId),
    // Supports the store's list ordering (updatedAt desc within a workspace).
    index(`idx_${tablePrefix}thread_workspace_updated`).on(table.workspaceId, table.updatedAt),
  ])

  const messages = sqliteTable(`${tablePrefix}message`, {
    id: hexId(),
    threadId: text('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'system', 'tool'] }).notNull(),
    content: text('content').notNull(),
    parts: text('parts', { mode: 'json' }).$type<ChatMessagePart[]>().default([]),
    toolName: text('tool_name'),
    model: text('model'),
    // Usage receipt, flattened from the harness's `step-finish` shape
    // (`tokens {input, output, reasoning, cache{read, write}}` + `cost`).
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    costUsd: real('cost_usd'),
    createdAt: createdAt(),
    ...messageExtras,
  }, (table) => [
    index(`idx_${tablePrefix}message_thread`).on(table.threadId),
    index(`idx_${tablePrefix}message_thread_created`).on(table.threadId, table.createdAt),
  ])

  return { threads, messages }
}

/**
 * The base (no-extras) table pair, pinned via an instantiation expression:
 * `ReturnType<typeof createChatTables>` on the bare generic substitutes the
 * extras params with their CONSTRAINT (`Record<string,
 * SQLiteColumnBuilderBase>`), stamping an index signature into the column map
 * that widens every concrete column to `unknown`/`notNull: false` — concrete
 * factory results then fail `extends ChatTables`. (`teams`' `createTeamTables`
 * is non-generic, so its plain `ReturnType` never hits this.)
 */
export type ChatTables = ReturnType<typeof createChatTables<{}, {}>>

/** Resolve the selected fields of a chat thread row from the chat threads table */
export type ChatThreadRow = ChatTables['threads']['$inferSelect']
/** Resolve the selected structure of a chat message row from the messages table */
export type ChatMessageRow = ChatTables['messages']['$inferSelect']
/** Resolve the type for inserting a new chat thread row into the threads table */
export type NewChatThreadRow = ChatTables['threads']['$inferInsert']
/** Resolve the type for inserting a new chat message row into the messages table */
export type NewChatMessageRow = ChatTables['messages']['$inferInsert']
