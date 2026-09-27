/**
 * Typed CRUD over the tables from `createChatTables`. Works against any
 * SQLite drizzle driver (D1, libsql, better-sqlite3) — builders are awaited,
 * never `.run()`/`.all()`, so sync and async drivers behave identically.
 *
 * Access control is an injected seam, never an import: single-thread routes
 * check workspace access themselves (they know the thread), while
 * `bulkDeleteThreads` REQUIRES an `assertAccess` callback because one request
 * can span workspaces — it is called once per distinct workspace and any
 * throw rejects the whole request before a single delete runs (fail-closed;
 * legal's bulk-delete semantics).
 *
 * Deletes run messages-first in ONE `db.batch` round trip when the driver has
 * one (D1, libsql), so a partial failure never leaves orphaned rows behind a
 * deleted thread; drivers without `batch` (better-sqlite3) fall back to
 * sequential awaits in the same order.
 */
import { type SQL } from 'drizzle-orm';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { type SqliteBatchDatabase } from '../store';
import type { ChatMessagePart } from './parts';
import type { ChatMessageRow, ChatTables, ChatThreadRow } from './schema';
/** Any SQLite drizzle database — `any` erases the driver-specific run-result
 *  and schema generics so better-sqlite3, D1, and libsql handles all fit.
 *  `batch` is structural: present on D1/libsql drizzle instances. */
export type ChatDatabase = BaseSQLiteDatabase<'sync' | 'async', any, any> & SqliteBatchDatabase;
/** Product-injected access check. Throw to deny; the store never interprets
 *  users or roles itself. */
export type WorkspaceAccessCheck = (workspaceId: string) => void | Promise<void>;
/** Define input parameters for listing threads within a workspace with pagination options */
export interface ListThreadsInput {
    workspaceId: string;
    /** Clamped to 1..200; default 50 (legal's list route semantics). */
    limit?: number;
    /** Clamped to >= 0; default 0. */
    offset?: number;
}
/** Represent a paginated collection of chat threads with total count and pagination details */
export interface ListThreadsResult<TThread = ChatThreadRow> {
    threads: TThread[];
    total: number;
    limit: number;
    offset: number;
}
/** Define input parameters required to create a new thread in a workspace */
export interface CreateThreadInput {
    /** Caller-assigned primary key. The agent gateway uses its validated
     *  conversation id so API and browser turns share one durable thread. */
    id?: string;
    workspaceId: string;
    /** Title source when `title` is absent: first non-empty line, 80-char cap
     *  (`threadTitleFromMessage`). */
    firstMessage?: string;
    /** Explicit title; still normalized through `threadTitleFromMessage` so a
     *  multi-page paste never becomes a sidebar entry. */
    title?: string;
    category?: string | null;
    isPinned?: boolean;
    /** Opaque product-column values written verbatim in the SAME insert (the
     *  `/missions` extras pattern). Never read, validated, or defaulted here. */
    extras?: Record<string, unknown>;
}
/** Define input parameters for appending a message to a chat thread with optional metadata */
export interface AppendMessageInput {
    /** Caller-assigned primary key. Omitted, the column default assigns a random
     *  hex id (today's behavior). Incremental assistant persistence passes a
     *  DETERMINISTIC id derived from the turn's own identity, so a re-entered
     *  turn (crashed worker, durable-driver retry) finds and updates the row a
     *  previous attempt started instead of inserting a second one. */
    id?: string;
    threadId: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    parts?: ChatMessagePart[];
    toolName?: string | null;
    model?: string | null;
    requestedModel?: string | null;
    servedModel?: string | null;
    servedProvider?: string | null;
    servedSource?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    reasoningTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    costUsd?: number | null;
    /** Opaque product-column values written verbatim in the SAME insert. */
    extras?: Record<string, unknown>;
}
/** Fields an existing message row may be patched with. Every field is
 *  optional and only DEFINED fields are written, so a partial patch never
 *  clears a column it does not mention. `threadId` and `role` are absent on
 *  purpose: a message never moves thread or changes speaker.
 *
 *  Exists for incremental assistant persistence — the streaming turn writes
 *  the row once and then patches it as content accumulates, so the durable
 *  transcript is at most one cadence interval behind the live stream. */
export interface UpdateMessageInput {
    content?: string;
    parts?: ChatMessagePart[];
    toolName?: string | null;
    model?: string | null;
    requestedModel?: string | null;
    servedModel?: string | null;
    servedProvider?: string | null;
    servedSource?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    reasoningTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    costUsd?: number | null;
    /** Opaque product-column values written verbatim in the SAME update. */
    extras?: Record<string, unknown>;
}
/** Define options to configure message listing with optional limit and offset parameters */
export interface ListMessagesOptions {
    limit?: number;
    offset?: number;
}
/** Define input for bulk deleting threads with access checks per workspace */
export interface BulkDeleteThreadsInput {
    ids: string[];
    /** Optional single-workspace fence for products whose route already resolved
     *  one active workspace. Omitted preserves the multi-workspace legal route. */
    workspaceId?: string;
    /** Called once per distinct workspace the ids touch, before ANY delete. */
    assertAccess: WorkspaceAccessCheck;
}
/** Delete threads selected by their last activity time within one workspace.
 *
 * Products can add a lifecycle predicate such as `status = 'active'` through
 * `where`; the store still owns workspace scope, access ordering, and message
 * cleanup for every consumer. */
export interface BulkDeleteThreadsByUpdatedAtInput {
    workspaceId: string;
    /** Exclusive upper bound: rows older than this instant. */
    updatedBefore?: Date;
    /** Inclusive lower bound: rows updated at or after this instant. */
    updatedAfter?: Date;
    where?: SQL;
    /** Called before any delete for the requested workspace. */
    assertAccess: WorkspaceAccessCheck;
}
/** Manage chat threads and messages with operations for listing, creating, updating, and deleting data */
export interface ChatStore<TThread = ChatThreadRow, TMessage = ChatMessageRow> {
    listThreads(input: ListThreadsInput): Promise<ListThreadsResult<TThread>>;
    getThread(threadId: string): Promise<TThread | null>;
    createThread(input: CreateThreadInput): Promise<TThread>;
    renameThread(threadId: string, title: string): Promise<TThread | null>;
    pinThread(threadId: string, isPinned: boolean): Promise<TThread | null>;
    /** Messages + thread in one batch. Resolves false when the thread does not
     *  exist. `assertAccess` (optional) receives the thread's workspaceId before
     *  the delete — single-thread callers usually check access themselves. */
    deleteThread(threadId: string, options?: {
        assertAccess?: WorkspaceAccessCheck;
    }): Promise<boolean>;
    bulkDeleteThreads(input: BulkDeleteThreadsInput): Promise<{
        deleted: number;
    }>;
    bulkDeleteThreadsByUpdatedAt(input: BulkDeleteThreadsByUpdatedAtInput): Promise<{
        deleted: number;
    }>;
    /** Ordered oldest-first: `created_at`, then rowid (insertion order within a
     *  same-second burst — a user+assistant pair lands in one epoch second). */
    listMessages(threadId: string, options?: ListMessagesOptions): Promise<TMessage[]>;
    /** Inserts the message and bumps the thread's `updatedAt` in one batch so
     *  workspace recency sorts stay truthful. */
    appendMessage(input: AppendMessageInput): Promise<TMessage>;
    /** Patches an existing message and bumps its thread's `updatedAt` in the
     *  same batch. Resolves `null` when the id does not exist. Only defined
     *  patch fields are written. */
    updateMessage(id: string, patch: UpdateMessageInput): Promise<TMessage | null>;
    /** Removes one message. Resolves false when the id does not exist. Used by
     *  incremental persistence to retract a draft row for a turn that ended
     *  producing nothing, so an empty assistant row is never left behind. */
    deleteMessage(id: string): Promise<boolean>;
}
/** Create a chat store managing threads and messages based on the provided database and tables */
export declare function createChatStore<TTables extends ChatTables>(db: ChatDatabase, tables: TTables): ChatStore<TTables['threads']['$inferSelect'], TTables['messages']['$inferSelect']>;
