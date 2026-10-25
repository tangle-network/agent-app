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
 * `extras` values verbatim in the SAME insert statement and never infers their
 * meaning). A product declaring a `metadata` column may use the store
 * metadata merge-patch operation; its fields remain opaque product data.
 *
 * SERVER-side module (D1/libsql/better-sqlite3 behind a worker or server
 * route) — but free of `node:` builtins on purpose: D1 workers have none.
 */

import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type {
  AnySQLiteColumn,
  AnySQLiteTable,
  SQLiteColumnBuilderBase,
  SQLiteTableExtraConfigValue,
} from 'drizzle-orm/sqlite-core'
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
  /**
   * Product indexes appended to the thread table's own, given the built
   * columns (extras included) so a product can index what it added.
   *
   * Names are used VERBATIM — `tablePrefix` is not applied — because these
   * have to byte-match indexes the product's migrations already created.
   *
   * Without this a product with one extra index cannot adopt the factory at
   * all: it keeps a hand-rolled duplicate of the same physical table, and the
   * two drift on the next factory change.
   */
  threadExtraIndexes?: ChatExtraIndexes
  /** Product indexes appended to the message table's own. Same rules as
   *  `threadExtraIndexes`. */
  messageExtraIndexes?: ChatExtraIndexes
}

/**
 * Builds product indexes from a table's columns.
 *
 * The column map is passed untyped because its shape depends on the product's
 * own extras; the RETURN is drizzle's own extra-config type, so the spread
 * below stays inside the union `sqliteTable` expects and the built table keeps
 * its inferred column types. Returning `unknown[]` here would force a cast on
 * the config array, which widens every column to the cross-dialect union and
 * breaks `db.select()` at every call site.
 */
export type ChatExtraIndexes = (
  columns: Record<string, AnySQLiteColumn>,
) => SQLiteTableExtraConfigValue[]

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
  const extraIndexes = (
    build: ChatExtraIndexes | undefined,
    table: Record<string, AnySQLiteColumn>,
  ): SQLiteTableExtraConfigValue[] => build?.(table) ?? []

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
    ...extraIndexes(options.threadExtraIndexes, table as unknown as Record<string, AnySQLiteColumn>),
  ])

  const messages = sqliteTable(`${tablePrefix}message`, {
    id: hexId(),
    threadId: text('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'system', 'tool'] }).notNull(),
    content: text('content').notNull(),
    parts: text('parts', { mode: 'json' }).$type<ChatMessagePart[]>().default([]),
    toolName: text('tool_name'),
    model: text('model'),
    requestedModel: text('requested_model'),
    servedModel: text('served_model'),
    servedProvider: text('served_provider'),
    servedSource: text('served_model_source'),
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
    ...extraIndexes(options.messageExtraIndexes, table as unknown as Record<string, AnySQLiteColumn>),
  ])

  return { threads, messages }
}

/**
 * Build the `thread_artifact_link` table: artifacts a thread mentioned or
 * touched beyond its own scope, inserted once on first reference. It powers a
 * thread's "also discussed" chips and the reverse "which threads touched this
 * file" lookup. `kinds` is the product's artifact-kind enum.
 */
export function createThreadArtifactLinksTable<const Kind extends string>(
  threadTable: ChatParentTable,
  kinds: readonly [Kind, ...Kind[]],
) {
  return sqliteTable('thread_artifact_link', {
    id: hexId(),
    threadId: text('thread_id').notNull().references(() => threadTable.id, { onDelete: 'cascade' }),
    artifactKind: text('artifact_kind', { enum: kinds }).notNull(),
    artifactKey: text('artifact_key').notNull(),
    firstReferencedAt: integer('first_referenced_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  }, (table) => [
    index('idx_thread_artifact_link_thread').on(table.threadId),
    uniqueIndex('idx_thread_artifact_link_unique').on(table.threadId, table.artifactKind, table.artifactKey),
    index('idx_thread_artifact_link_reverse').on(table.artifactKind, table.artifactKey),
  ])
}

/**
 * Build the `agent_run` table: one row per agent run in a workspace, with the
 * product's run telemetry as JSON `metadata`. `idx_agent_run_workspace` covers
 * `(workspace_id, agent_id)`, or `workspace_id` alone with `indexAgentId: false`
 * for products whose migration created it that way.
 */
export function createAgentRunsTable<Metadata = Record<string, unknown>>(
  workspaceTable: ChatParentTable,
  options: { indexAgentId?: boolean } = {},
) {
  return sqliteTable('agent_run', {
    id: hexId(),
    workspaceId: text('workspace_id').notNull().references(() => workspaceTable.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    status: text('status', { enum: ['running', 'completed', 'failed'] }).notNull().default('running'),
    success: integer('success', { mode: 'boolean' }).notNull().default(true),
    resultSummary: text('result_summary'),
    metadata: text('metadata', { mode: 'json' }).$type<Metadata>(),
    startedAt: integer('started_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
  }, (table) => [
    options.indexAgentId === false
      ? index('idx_agent_run_workspace').on(table.workspaceId)
      : index('idx_agent_run_workspace').on(table.workspaceId, table.agentId),
  ])
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
