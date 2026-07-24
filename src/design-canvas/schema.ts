/**
 * Drizzle schema factory for design-canvas tables. The product owns the
 * workspace/user tables; the factory wires design-canvas foreign keys into
 * them so the whole graph lives in one drizzle schema with real cascade
 * semantics. Column names and conventions mirror the sequences schema so
 * products with both surfaces share a DDL style.
 *
 * The `document` column persists the full SceneDocument as JSON. Rev starts
 * at 1 on insert and increments atomically on every successful saveDocument —
 * optimistic concurrency without merge machinery.
 *
 * `isTemplate` marks documents that serve as fill-in-slots templates; the
 * index on (workspaceId, isTemplate) makes template browsing fast.
 */

import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteColumn, AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import type { SceneDocument } from './model'

/** A product table referenced by FK — only the `id` column is touched. */
export type DesignCanvasParentTable = AnySQLiteTable & { id: AnySQLiteColumn }

/** Define options for creating design canvas tables including workspace and user table configurations */
export interface CreateDesignCanvasTablesOptions {
  workspaceTable: DesignCanvasParentTable
  userTable: DesignCanvasParentTable
}

const hexId = () => text('id').primaryKey().default(sql`(lower(hex(randomblob(16))))`)

const jsonMetadata = () => text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().default({})

const createdAt = () => integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)

const updatedAt = () => integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)

/** Build SQLite tables for design documents with workspace and user references */
export function createDesignCanvasTables(opts: CreateDesignCanvasTablesOptions) {
  const { workspaceTable, userTable } = opts

  const designDocuments = sqliteTable('design_document', {
    id: hexId(),
    workspaceId: text('workspace_id').notNull().references(() => workspaceTable.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** Full SceneDocument serialized as JSON — persisted and replaced atomically. */
    document: text('document', { mode: 'json' }).$type<SceneDocument>().notNull(),
    /** Monotonic revision; starts at 1, incremented by every successful save. */
    rev: integer('rev').notNull().default(1),
    /** True when this document is a slot-fillable template for data binding. */
    isTemplate: integer('is_template', { mode: 'boolean' }).notNull().default(false),
    createdBy: text('created_by').notNull().references(() => userTable.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  }, (table) => [
    index('idx_design_document_workspace_updated').on(table.workspaceId, table.updatedAt),
    index('idx_design_document_workspace_template').on(table.workspaceId, table.isTemplate),
  ])

  const designDecisions = sqliteTable('design_decision', {
    id: hexId(),
    documentId: text('document_id').notNull().references(() => designDocuments.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull().references(() => workspaceTable.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['human_edit', 'agent_edit', 'agent_proposal', 'export', 'note'] }).notNull(),
    instruction: text('instruction').notNull(),
    reasoningSummary: text('reasoning_summary'),
    metadata: jsonMetadata(),
    createdBy: text('created_by').notNull().references(() => userTable.id),
    createdAt: createdAt(),
  }, (table) => [
    index('idx_design_decision_document').on(table.documentId, table.createdAt),
    index('idx_design_decision_workspace').on(table.workspaceId),
  ])

  const designExports = sqliteTable('design_export', {
    id: hexId(),
    documentId: text('document_id').notNull().references(() => designDocuments.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull().references(() => workspaceTable.id, { onDelete: 'cascade' }),
    format: text('format', { enum: ['png', 'jpeg', 'json'] }).notNull(),
    status: text('status', { enum: ['queued', 'processing', 'completed', 'failed'] }).notNull().default('queued'),
    resultUrl: text('result_url'),
    metadata: jsonMetadata(),
    createdBy: text('created_by').notNull().references(() => userTable.id),
    createdAt: createdAt(),
  }, (table) => [
    index('idx_design_export_document').on(table.documentId, table.createdAt),
    index('idx_design_export_workspace').on(table.workspaceId),
  ])

  return { designDocuments, designDecisions, designExports }
}

/** Resolve the structure and data of design canvas tables for rendering and manipulation */
export type DesignCanvasTables = ReturnType<typeof createDesignCanvasTables>

/** Resolve the selected structure of a design document row from design canvas tables */
export type DesignDocumentRow = DesignCanvasTables['designDocuments']['$inferSelect']
/** Resolve a design decision row from the design decisions table selection */
export type DesignDecisionRow = DesignCanvasTables['designDecisions']['$inferSelect']
/** Resolve the selected fields of designExports from DesignCanvasTables */
export type DesignExportRow = DesignCanvasTables['designExports']['$inferSelect']
