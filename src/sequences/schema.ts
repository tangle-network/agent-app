/**
 * Drizzle schema factory for the sequence tables. The product owns the
 * workspace/user (and optionally generation/asset) tables; the factory wires
 * the sequence tables' foreign keys into them so the whole graph lives in one
 * drizzle schema with real cascade semantics. Column names, types, defaults,
 * enums, and indexes mirror creative-agent's hand-rolled tables so a product
 * with those tables can adopt the factory without rewriting rows.
 *
 * `sequence_clip.text` / `sequence_clip.language` hold caption bodies inline
 * (nullable; only caption-track clips use them) — adopting products add the
 * two columns with a plain ALTER TABLE.
 *
 * When `generationTable`/`assetTable` are omitted the `generation_id` /
 * `asset_id` columns stay plain text (no FK): products without those tables
 * still get opaque reference columns the store round-trips untouched.
 */

import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteColumn, AnySQLiteTable } from 'drizzle-orm/sqlite-core'

/** A product table referenced by FK — only the `id` column is touched. */
export type SequenceParentTable = AnySQLiteTable & { id: AnySQLiteColumn }

export interface CreateSequenceTablesOptions {
  workspaceTable: SequenceParentTable
  userTable: SequenceParentTable
  generationTable?: SequenceParentTable
  assetTable?: SequenceParentTable
}

const hexId = () => text('id').primaryKey().default(sql`(lower(hex(randomblob(16))))`)

const jsonMetadata = () => text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().default({})

const createdAt = () => integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)

const updatedAt = () => integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)

export function createSequenceTables(opts: CreateSequenceTablesOptions) {
  const { workspaceTable, userTable, generationTable, assetTable } = opts

  const sequences = sqliteTable('sequence', {
    id: hexId(),
    workspaceId: text('workspace_id').notNull().references(() => workspaceTable.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    fps: integer('fps').notNull().default(30),
    width: integer('width').notNull().default(1080),
    height: integer('height').notNull().default(1920),
    aspectRatio: text('aspect_ratio').notNull().default('9:16'),
    durationFrames: integer('duration_frames').notNull().default(900),
    status: text('status', { enum: ['draft', 'active', 'exporting', 'archived'] }).notNull().default('draft'),
    metadata: jsonMetadata(),
    createdBy: text('created_by').notNull().references(() => userTable.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  }, (table) => [
    index('idx_sequence_workspace_status').on(table.workspaceId, table.status),
    index('idx_sequence_workspace_updated').on(table.workspaceId, table.updatedAt),
  ])

  const sequenceTracks = sqliteTable('sequence_track', {
    id: hexId(),
    sequenceId: text('sequence_id').notNull().references(() => sequences.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull().references(() => workspaceTable.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['video', 'audio', 'caption', 'reference', 'agent'] }).notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    locked: integer('locked', { mode: 'boolean' }).notNull().default(false),
    muted: integer('muted', { mode: 'boolean' }).notNull().default(false),
    metadata: jsonMetadata(),
    createdAt: createdAt(),
  }, (table) => [
    index('idx_sequence_track_sequence_order').on(table.sequenceId, table.sortOrder),
    index('idx_sequence_track_workspace').on(table.workspaceId),
  ])

  const sequenceClips = sqliteTable('sequence_clip', {
    id: hexId(),
    sequenceId: text('sequence_id').notNull().references(() => sequences.id, { onDelete: 'cascade' }),
    trackId: text('track_id').notNull().references(() => sequenceTracks.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull().references(() => workspaceTable.id, { onDelete: 'cascade' }),
    assetId: assetTable
      ? text('asset_id').references(() => assetTable.id, { onDelete: 'set null' })
      : text('asset_id'),
    generationId: generationTable
      ? text('generation_id').references(() => generationTable.id, { onDelete: 'set null' })
      : text('generation_id'),
    label: text('label').notNull(),
    startFrame: integer('start_frame').notNull().default(0),
    durationFrames: integer('duration_frames').notNull(),
    sourceInFrame: integer('source_in_frame').notNull().default(0),
    sourceOutFrame: integer('source_out_frame'),
    version: integer('version').notNull().default(1),
    disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
    text: text('text'),
    language: text('language'),
    metadata: jsonMetadata(),
    createdBy: text('created_by').notNull().references(() => userTable.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  }, (table) => [
    index('idx_sequence_clip_sequence_start').on(table.sequenceId, table.startFrame),
    index('idx_sequence_clip_track_start').on(table.trackId, table.startFrame),
    index('idx_sequence_clip_generation').on(table.generationId),
    index('idx_sequence_clip_workspace').on(table.workspaceId),
  ])

  const sequenceDecisions = sqliteTable('sequence_decision', {
    id: hexId(),
    sequenceId: text('sequence_id').notNull().references(() => sequences.id, { onDelete: 'cascade' }),
    clipId: text('clip_id').references(() => sequenceClips.id, { onDelete: 'set null' }),
    workspaceId: text('workspace_id').notNull().references(() => workspaceTable.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['human_edit', 'agent_proposal', 'agent_edit', 'export', 'note'] }).notNull(),
    instruction: text('instruction').notNull(),
    reasoningSummary: text('reasoning_summary'),
    accepted: integer('accepted', { mode: 'boolean' }),
    metadata: jsonMetadata(),
    createdBy: text('created_by').notNull().references(() => userTable.id),
    createdAt: createdAt(),
  }, (table) => [
    index('idx_sequence_decision_sequence').on(table.sequenceId, table.createdAt),
    index('idx_sequence_decision_workspace').on(table.workspaceId),
  ])

  const sequenceExports = sqliteTable('sequence_export', {
    id: hexId(),
    workspaceId: text('workspace_id').notNull().references(() => workspaceTable.id, { onDelete: 'cascade' }),
    sequenceId: text('sequence_id').notNull().references(() => sequences.id, { onDelete: 'cascade' }),
    format: text('format', { enum: ['mp4', 'otio', 'xml', 'edl', 'vtt', 'srt', 'contact_sheet'] }).notNull(),
    status: text('status', { enum: ['queued', 'processing', 'completed', 'failed', 'cancelled'] }).notNull().default('queued'),
    resultUrl: text('result_url'),
    metadata: jsonMetadata(),
    createdBy: text('created_by').notNull().references(() => userTable.id),
    createdAt: createdAt(),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
  }, (table) => [
    index('idx_sequence_export_sequence').on(table.sequenceId, table.createdAt),
    index('idx_sequence_export_workspace_status').on(table.workspaceId, table.status),
  ])

  return { sequences, sequenceTracks, sequenceClips, sequenceDecisions, sequenceExports }
}

export type SequenceTables = ReturnType<typeof createSequenceTables>

export type SequenceRow = SequenceTables['sequences']['$inferSelect']
export type SequenceTrackRow = SequenceTables['sequenceTracks']['$inferSelect']
export type SequenceClipRow = SequenceTables['sequenceClips']['$inferSelect']
export type SequenceDecisionRow = SequenceTables['sequenceDecisions']['$inferSelect']
export type SequenceExportRow = SequenceTables['sequenceExports']['$inferSelect']
