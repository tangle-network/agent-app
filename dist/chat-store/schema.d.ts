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
import type { AnySQLiteColumn, AnySQLiteTable, SQLiteColumnBuilderBase, SQLiteTableExtraConfigValue } from 'drizzle-orm/sqlite-core';
import type { ChatMessagePart } from './parts';
/** A product table referenced by FK — only the `id` column is touched. */
export type ChatParentTable = AnySQLiteTable & {
    id: AnySQLiteColumn;
};
/** Define options to customize chat thread and message table creation including workspace and naming prefixes */
export interface CreateChatTablesOptions<TThreadExtras extends Record<string, SQLiteColumnBuilderBase> = {}, TMessageExtras extends Record<string, SQLiteColumnBuilderBase> = {}> {
    /** The product's workspace table — threads reference `workspaceTable.id`
     *  with cascade. Omitted: `workspace_id` stays a plain indexed text column
     *  (products whose tenant table lives in another database). */
    workspaceTable?: ChatParentTable;
    /** Prefixes table AND index names (`'chat_'` → `chat_thread`,
     *  `idx_chat_thread_workspace`) for products that namespace chat tables in a
     *  shared database. Default: unprefixed `thread`/`message` (legal/gtm row
     *  compatibility). */
    tablePrefix?: string;
    /** Product columns merged into the thread table (the `/missions` extras
     *  pattern) — e.g. a `status` lifecycle enum or gtm's scope columns. */
    threadExtraColumns?: TThreadExtras;
    /** Product columns merged into the message table — e.g. legal's
     *  `vault_files`. */
    messageExtraColumns?: TMessageExtras;
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
    threadExtraIndexes?: ChatExtraIndexes;
    /** Product indexes appended to the message table's own. Same rules as
     *  `threadExtraIndexes`. */
    messageExtraIndexes?: ChatExtraIndexes;
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
export type ChatExtraIndexes = (columns: Record<string, AnySQLiteColumn>) => SQLiteTableExtraConfigValue[];
/** Build chat-related SQLite tables with customizable thread and message columns */
export declare function createChatTables<TThreadExtras extends Record<string, SQLiteColumnBuilderBase> = {}, TMessageExtras extends Record<string, SQLiteColumnBuilderBase> = {}>(options?: CreateChatTablesOptions<TThreadExtras, TMessageExtras>): {
    threads: import("drizzle-orm/sqlite-core").SQLiteTableWithColumns<{
        name: `${string}thread`;
        schema: undefined;
        columns: {
            id: import("drizzle-orm").HasDefault<import("drizzle-orm").IsPrimaryKey<import("drizzle-orm").NotNull<import("drizzle-orm/sqlite-core").SQLiteTextBuilderInitial<"id", [string, ...string[]], number | undefined>>>>;
            workspaceId: import("drizzle-orm").NotNull<import("drizzle-orm/sqlite-core").SQLiteTextBuilderInitial<"workspace_id", [string, ...string[]], number | undefined>>;
            title: import("drizzle-orm").NotNull<import("drizzle-orm/sqlite-core").SQLiteTextBuilderInitial<"title", [string, ...string[]], number | undefined>>;
            category: import("drizzle-orm/sqlite-core").SQLiteTextBuilderInitial<"category", [string, ...string[]], number | undefined>;
            isPinned: import("drizzle-orm").HasDefault<import("drizzle-orm").NotNull<import("drizzle-orm/sqlite-core").SQLiteBooleanBuilderInitial<"is_pinned">>>;
            createdAt: import("drizzle-orm").HasDefault<import("drizzle-orm").NotNull<import("drizzle-orm/sqlite-core").SQLiteTimestampBuilderInitial<"created_at">>>;
            updatedAt: import("drizzle-orm").HasDefault<import("drizzle-orm").NotNull<import("drizzle-orm/sqlite-core").SQLiteTimestampBuilderInitial<"updated_at">>>;
        } & TThreadExtras extends infer T extends Record<string, import("drizzle-orm").ColumnBuilderBase<import("drizzle-orm").ColumnBuilderBaseConfig<import("drizzle-orm").ColumnDataType, string>, object>> ? { [Key in keyof T]: import("drizzle-orm").BuildColumn<TTableName, {
            _: Omit<T[Key]["_"], "name"> & {
                name: T[Key]["_"]["name"] extends "" ? import("drizzle-orm").Assume<Key, string> : T[Key]["_"]["name"];
            };
        }, TDialect>; } : never;
        dialect: 'sqlite';
    }>;
    messages: import("drizzle-orm/sqlite-core").SQLiteTableWithColumns<{
        name: `${string}message`;
        schema: undefined;
        columns: {
            id: import("drizzle-orm").HasDefault<import("drizzle-orm").IsPrimaryKey<import("drizzle-orm").NotNull<import("drizzle-orm/sqlite-core").SQLiteTextBuilderInitial<"id", [string, ...string[]], number | undefined>>>>;
            threadId: import("drizzle-orm").NotNull<import("drizzle-orm/sqlite-core").SQLiteTextBuilderInitial<"thread_id", [string, ...string[]], number | undefined>>;
            role: import("drizzle-orm").NotNull<import("drizzle-orm/sqlite-core").SQLiteTextBuilderInitial<"role", ["user", "assistant", "system", "tool"], number | undefined>>;
            content: import("drizzle-orm").NotNull<import("drizzle-orm/sqlite-core").SQLiteTextBuilderInitial<"content", [string, ...string[]], number | undefined>>;
            parts: import("drizzle-orm").HasDefault<import("drizzle-orm").$Type<import("drizzle-orm/sqlite-core").SQLiteTextJsonBuilderInitial<"parts">, ChatMessagePart[]>>;
            toolName: import("drizzle-orm/sqlite-core").SQLiteTextBuilderInitial<"tool_name", [string, ...string[]], number | undefined>;
            model: import("drizzle-orm/sqlite-core").SQLiteTextBuilderInitial<"model", [string, ...string[]], number | undefined>;
            requestedModel: import("drizzle-orm/sqlite-core").SQLiteTextBuilderInitial<"requested_model", [string, ...string[]], number | undefined>;
            servedModel: import("drizzle-orm/sqlite-core").SQLiteTextBuilderInitial<"served_model", [string, ...string[]], number | undefined>;
            servedProvider: import("drizzle-orm/sqlite-core").SQLiteTextBuilderInitial<"served_provider", [string, ...string[]], number | undefined>;
            servedSource: import("drizzle-orm/sqlite-core").SQLiteTextBuilderInitial<"served_model_source", [string, ...string[]], number | undefined>;
            inputTokens: import("drizzle-orm/sqlite-core").SQLiteIntegerBuilderInitial<"input_tokens">;
            outputTokens: import("drizzle-orm/sqlite-core").SQLiteIntegerBuilderInitial<"output_tokens">;
            reasoningTokens: import("drizzle-orm/sqlite-core").SQLiteIntegerBuilderInitial<"reasoning_tokens">;
            cacheReadTokens: import("drizzle-orm/sqlite-core").SQLiteIntegerBuilderInitial<"cache_read_tokens">;
            cacheWriteTokens: import("drizzle-orm/sqlite-core").SQLiteIntegerBuilderInitial<"cache_write_tokens">;
            costUsd: import("drizzle-orm/sqlite-core").SQLiteRealBuilderInitial<"cost_usd">;
            createdAt: import("drizzle-orm").HasDefault<import("drizzle-orm").NotNull<import("drizzle-orm/sqlite-core").SQLiteTimestampBuilderInitial<"created_at">>>;
        } & TMessageExtras extends infer T_1 extends Record<string, import("drizzle-orm").ColumnBuilderBase<import("drizzle-orm").ColumnBuilderBaseConfig<import("drizzle-orm").ColumnDataType, string>, object>> ? { [Key in keyof T_1]: import("drizzle-orm").BuildColumn<TTableName, {
            _: Omit<T_1[Key]["_"], "name"> & {
                name: T_1[Key]["_"]["name"] extends "" ? import("drizzle-orm").Assume<Key, string> : T_1[Key]["_"]["name"];
            };
        }, TDialect>; } : never;
        dialect: 'sqlite';
    }>;
};
/**
 * The base (no-extras) table pair, pinned via an instantiation expression:
 * `ReturnType<typeof createChatTables>` on the bare generic substitutes the
 * extras params with their CONSTRAINT (`Record<string,
 * SQLiteColumnBuilderBase>`), stamping an index signature into the column map
 * that widens every concrete column to `unknown`/`notNull: false` — concrete
 * factory results then fail `extends ChatTables`. (`teams`' `createTeamTables`
 * is non-generic, so its plain `ReturnType` never hits this.)
 */
export type ChatTables = ReturnType<typeof createChatTables<{}, {}>>;
/** Resolve the selected fields of a chat thread row from the chat threads table */
export type ChatThreadRow = ChatTables['threads']['$inferSelect'];
/** Resolve the selected structure of a chat message row from the messages table */
export type ChatMessageRow = ChatTables['messages']['$inferSelect'];
/** Resolve the type for inserting a new chat thread row into the threads table */
export type NewChatThreadRow = ChatTables['threads']['$inferInsert'];
/** Resolve the type for inserting a new chat message row into the messages table */
export type NewChatMessageRow = ChatTables['messages']['$inferInsert'];
