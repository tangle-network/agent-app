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

import { asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import { BULK_DELETE_MAX_THREADS, ChatStoreInputError, threadTitleFromMessage } from './core'
import type { ChatMessagePart } from './parts'
import type { ChatMessageRow, ChatTables, ChatThreadRow, NewChatMessageRow, NewChatThreadRow } from './schema'

/** Any SQLite drizzle database — `any` erases the driver-specific run-result
 *  and schema generics so better-sqlite3, D1, and libsql handles all fit.
 *  `batch` is structural: present on D1/libsql drizzle instances. */
export type ChatDatabase = BaseSQLiteDatabase<'sync' | 'async', any, any> & {
  batch?: (statements: [unknown, ...unknown[]]) => Promise<unknown[]>
}

/** Product-injected access check. Throw to deny; the store never interprets
 *  users or roles itself. */
export type WorkspaceAccessCheck = (workspaceId: string) => void | Promise<void>

/** Define input parameters for listing threads within a workspace with pagination options */
export interface ListThreadsInput {
  workspaceId: string
  /** Clamped to 1..200; default 50 (legal's list route semantics). */
  limit?: number
  /** Clamped to >= 0; default 0. */
  offset?: number
}

/** Represent a paginated collection of chat threads with total count and pagination details */
export interface ListThreadsResult<TThread = ChatThreadRow> {
  threads: TThread[]
  total: number
  limit: number
  offset: number
}

/** Define input parameters required to create a new thread in a workspace */
export interface CreateThreadInput {
  workspaceId: string
  /** Title source when `title` is absent: first non-empty line, 80-char cap
   *  (`threadTitleFromMessage`). */
  firstMessage?: string
  /** Explicit title; still normalized through `threadTitleFromMessage` so a
   *  multi-page paste never becomes a sidebar entry. */
  title?: string
  category?: string | null
  isPinned?: boolean
  /** Opaque product-column values written verbatim in the SAME insert (the
   *  `/missions` extras pattern). Never read, validated, or defaulted here. */
  extras?: Record<string, unknown>
}

/** Define input parameters for appending a message to a chat thread with optional metadata */
export interface AppendMessageInput {
  threadId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  parts?: ChatMessagePart[]
  toolName?: string | null
  model?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  reasoningTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  costUsd?: number | null
  /** Opaque product-column values written verbatim in the SAME insert. */
  extras?: Record<string, unknown>
}

/** Define options to configure message listing with optional limit and offset parameters */
export interface ListMessagesOptions {
  limit?: number
  offset?: number
}

/** Define input for bulk deleting threads with access checks per workspace */
export interface BulkDeleteThreadsInput {
  ids: string[]
  /** Called once per distinct workspace the ids touch, before ANY delete. */
  assertAccess: WorkspaceAccessCheck
}

/** Manage chat threads and messages with operations for listing, creating, updating, and deleting data */
export interface ChatStore<TThread = ChatThreadRow, TMessage = ChatMessageRow> {
  listThreads(input: ListThreadsInput): Promise<ListThreadsResult<TThread>>
  getThread(threadId: string): Promise<TThread | null>
  createThread(input: CreateThreadInput): Promise<TThread>
  renameThread(threadId: string, title: string): Promise<TThread | null>
  pinThread(threadId: string, isPinned: boolean): Promise<TThread | null>
  /** Messages + thread in one batch. Resolves false when the thread does not
   *  exist. `assertAccess` (optional) receives the thread's workspaceId before
   *  the delete — single-thread callers usually check access themselves. */
  deleteThread(threadId: string, options?: { assertAccess?: WorkspaceAccessCheck }): Promise<boolean>
  bulkDeleteThreads(input: BulkDeleteThreadsInput): Promise<{ deleted: number }>
  /** Ordered oldest-first: `created_at`, then rowid (insertion order within a
   *  same-second burst — a user+assistant pair lands in one epoch second). */
  listMessages(threadId: string, options?: ListMessagesOptions): Promise<TMessage[]>
  /** Inserts the message and bumps the thread's `updatedAt` in one batch so
   *  workspace recency sorts stay truthful. */
  appendMessage(input: AppendMessageInput): Promise<TMessage>
}

/** One driver round trip when `db.batch` exists; sequential awaits in the
 *  given order otherwise. Statement order is the caller's integrity contract
 *  (children before parents). */
async function runStatements(
  db: ChatDatabase,
  statements: [unknown, ...unknown[]],
): Promise<unknown[]> {
  if (typeof db.batch === 'function') {
    return await db.batch(statements)
  }
  const results: unknown[] = []
  for (const statement of statements) results.push(await statement)
  return results
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  const value = Number.isFinite(limit) ? Math.trunc(limit as number) : fallback
  return Math.min(Math.max(value, 1), max)
}

function clampOffset(offset: number | undefined): number {
  const value = Number.isFinite(offset) ? Math.trunc(offset as number) : 0
  return Math.max(value, 0)
}

/** Create a chat store managing threads and messages based on the provided database and tables */
export function createChatStore<TTables extends ChatTables>(
  db: ChatDatabase,
  tables: TTables,
): ChatStore<TTables['threads']['$inferSelect'], TTables['messages']['$inferSelect']> {
  type TThread = TTables['threads']['$inferSelect']
  type TMessage = TTables['messages']['$inferSelect']
  const threads = tables.threads as ChatTables['threads']
  const messages = tables.messages as ChatTables['messages']

  return {
    async listThreads(input) {
      const limit = clampLimit(input.limit, 50, 200)
      const offset = clampOffset(input.offset)
      const scope = eq(threads.workspaceId, input.workspaceId)
      const [list, [countRow]] = await Promise.all([
        db.select().from(threads).where(scope)
          // `id` tiebreak keeps pagination stable across same-second updates.
          .orderBy(desc(threads.updatedAt), asc(threads.id))
          .limit(limit)
          .offset(offset),
        db.select({ total: sql<number>`count(*)` }).from(threads).where(scope),
      ])
      return { threads: list as TThread[], total: countRow?.total ?? 0, limit, offset }
    },

    async getThread(threadId) {
      const [row] = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1)
      return (row as TThread | undefined) ?? null
    },

    async createThread(input) {
      const title = threadTitleFromMessage(input.title ?? input.firstMessage ?? '')
      const values = {
        workspaceId: input.workspaceId,
        title,
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.isPinned !== undefined ? { isPinned: input.isPinned } : {}),
        ...(input.extras ?? {}),
      } as NewChatThreadRow
      const [row] = await db.insert(threads).values(values).returning()
      if (!row) throw new Error('thread insert returned no row')
      return row as TThread
    },

    async renameThread(threadId, title) {
      const trimmed = title.trim()
      if (!trimmed) throw new ChatStoreInputError('Missing title')
      const [row] = await db.update(threads)
        .set({ title: trimmed, updatedAt: new Date() })
        .where(eq(threads.id, threadId))
        .returning()
      return (row as TThread | undefined) ?? null
    },

    async pinThread(threadId, isPinned) {
      const [row] = await db.update(threads)
        .set({ isPinned, updatedAt: new Date() })
        .where(eq(threads.id, threadId))
        .returning()
      return (row as TThread | undefined) ?? null
    },

    async deleteThread(threadId, options) {
      const [existing] = await db.select({ id: threads.id, workspaceId: threads.workspaceId })
        .from(threads)
        .where(eq(threads.id, threadId))
        .limit(1)
      if (!existing) return false
      if (options?.assertAccess) await options.assertAccess(existing.workspaceId)
      // Messages first so a partial failure never leaves orphaned rows behind
      // a deleted thread.
      await runStatements(db, [
        db.delete(messages).where(eq(messages.threadId, threadId)),
        db.delete(threads).where(eq(threads.id, threadId)),
      ])
      return true
    },

    async bulkDeleteThreads(input) {
      const { ids, assertAccess } = input
      if (typeof assertAccess !== 'function') throw new ChatStoreInputError('Missing assertAccess')
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string' && id.length > 0)) {
        throw new ChatStoreInputError('Missing ids')
      }
      if (ids.length > BULK_DELETE_MAX_THREADS) {
        throw new ChatStoreInputError(`Too many ids (max ${BULK_DELETE_MAX_THREADS})`)
      }

      const rows = await db.select({ id: threads.id, workspaceId: threads.workspaceId })
        .from(threads)
        .where(inArray(threads.id, ids))
      if (rows.length === 0) return { deleted: 0 }

      // Access is verified once per workspace the ids touch. Fail-closed: one
      // inaccessible workspace rejects the whole request before any delete.
      // Sorted so the check order (and therefore which denial surfaces) is
      // deterministic — row order follows random hex ids and varies per run.
      const workspaceIds = [...new Set(rows.map((row) => row.workspaceId))].sort()
      for (const workspaceId of workspaceIds) {
        await assertAccess(workspaceId)
      }

      const foundIds = rows.map((row) => row.id)
      await runStatements(db, [
        db.delete(messages).where(inArray(messages.threadId, foundIds)),
        db.delete(threads).where(inArray(threads.id, foundIds)),
      ])
      return { deleted: foundIds.length }
    },

    async listMessages(threadId, options) {
      const query = db.select().from(messages)
        .where(eq(messages.threadId, threadId))
        .orderBy(asc(messages.createdAt), sql`rowid`)
        .$dynamic()
      if (options?.limit !== undefined) query.limit(clampLimit(options.limit, 1, 1000))
      if (options?.offset !== undefined) query.offset(clampOffset(options.offset))
      return await query as TMessage[]
    },

    async appendMessage(input) {
      const values = {
        threadId: input.threadId,
        role: input.role,
        content: input.content,
        ...(input.parts !== undefined ? { parts: input.parts } : {}),
        ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
        ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
        ...(input.reasoningTokens !== undefined ? { reasoningTokens: input.reasoningTokens } : {}),
        ...(input.cacheReadTokens !== undefined ? { cacheReadTokens: input.cacheReadTokens } : {}),
        ...(input.cacheWriteTokens !== undefined ? { cacheWriteTokens: input.cacheWriteTokens } : {}),
        ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
        ...(input.extras ?? {}),
      } as NewChatMessageRow
      const [insertResult] = await runStatements(db, [
        db.insert(messages).values(values).returning(),
        db.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, input.threadId)),
      ])
      const row = (insertResult as TMessage[] | undefined)?.[0]
      if (!row) throw new Error('message insert returned no row')
      return row
    },
  }
}
