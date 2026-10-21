/**
 * Drizzle (SQLite / D1) table for generated media: one row per generated
 * image, video, speech, avatar or transcription, with its provider metadata as
 * JSON. A product owns its workspace and thread tables; the factory wires the
 * foreign keys into them so the row lives in the product's one drizzle schema.
 * Its own subpath because it imports `drizzle-orm` at module top.
 */
import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteColumn, AnySQLiteTable } from 'drizzle-orm/sqlite-core'

/** A product table referenced by FK: only the `id` column is touched. */
export type GenerationParentTable = AnySQLiteTable & { id: AnySQLiteColumn }

export interface CreateGenerationsTableOptions {
  workspaceTable: GenerationParentTable
  threadTable: GenerationParentTable
  /** What deleting a thread does to its generations; omitted keeps the database default (no action). */
  threadOnDelete?: 'cascade' | 'set null' | 'restrict' | 'no action'
  /** Index generations by thread, for products that list a thread's media. */
  indexThread?: boolean
}

/** Build the `generation` table. */
export function createGenerationsTable(opts: CreateGenerationsTableOptions) {
  const { workspaceTable, threadTable, threadOnDelete, indexThread } = opts
  return sqliteTable('generation', {
    id: text('id').primaryKey().default(sql`(lower(hex(randomblob(16))))`),
    workspaceId: text('workspace_id').notNull().references(() => workspaceTable.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(() => threadTable.id, threadOnDelete ? { onDelete: threadOnDelete } : undefined),
    type: text('type', { enum: ['image', 'video', 'avatar', 'speech', 'transcription'] }).notNull(),
    prompt: text('prompt').notNull(),
    result: text('result'),
    model: text('model'),
    cost: real('cost'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  }, (table) => [
    index('idx_generation_workspace').on(table.workspaceId),
    index('idx_generation_workspace_type').on(table.workspaceId, table.type),
    ...(indexThread ? [index('idx_generation_thread').on(table.threadId)] : []),
  ])
}
