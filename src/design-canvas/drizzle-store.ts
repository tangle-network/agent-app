/**
 * Drizzle-backed `SceneStore` over the tables from `createDesignCanvasTables`.
 * Works against any SQLite drizzle driver (better-sqlite3, D1, libsql).
 *
 * Defense in depth: RBAC runs before the store is constructed, but every
 * query still pins `workspaceId` AND `documentId` from the scope in its WHERE
 * clause, so a leaked or attacker-supplied row id from another workspace can
 * never read or write across the boundary — it surfaces as "not found".
 *
 * Optimistic concurrency for saveDocument: the UPDATE WHERE clause includes
 * `rev = expectedRev`; when 0 rows are changed (stale revision or missing
 * document), the store reads back the row to emit a precise error — either
 * "stale rev" or "not found" — so callers know whether to refetch-and-replay
 * or abort.
 */

import { and, desc, eq, sql } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type { SceneDocument } from './model'
import type {
  NewSceneDecision,
  SceneDecision,
  SceneDocumentRecord,
  SceneExportFormat,
  SceneExportRecord,
  SceneStore,
  SceneStoreScope,
} from './store'
import type {
  DesignCanvasTables,
  DesignDecisionRow,
  DesignDocumentRow,
  DesignExportRow,
} from './schema'

/** Any SQLite drizzle database — `any` erases the driver-specific run-result
 *  and schema generics so better-sqlite3, D1, and libsql handles all fit. */
export type DesignCanvasDatabase = BaseSQLiteDatabase<'sync' | 'async', any, any>

export interface CreateDrizzleSceneStoreOptions {
  db: DesignCanvasDatabase
  tables: DesignCanvasTables
  scope: SceneStoreScope
}

const DEFAULT_LIST_LIMIT = 50

export function createDrizzleSceneStore(options: CreateDrizzleSceneStoreOptions): SceneStore {
  const { db, tables, scope } = options
  const { designDocuments, designDecisions, designExports } = tables

  const docScope = () => and(
    eq(designDocuments.id, scope.documentId),
    eq(designDocuments.workspaceId, scope.workspaceId),
  )

  const decisionScope = () => and(
    eq(designDecisions.documentId, scope.documentId),
    eq(designDecisions.workspaceId, scope.workspaceId),
  )

  const exportScope = () => and(
    eq(designExports.documentId, scope.documentId),
    eq(designExports.workspaceId, scope.workspaceId),
  )

  async function requireDocumentRow(): Promise<DesignDocumentRow> {
    const [row] = await db.select().from(designDocuments).where(docScope()).limit(1)
    if (!row) {
      throw new Error(`Design document ${scope.documentId} not found in workspace ${scope.workspaceId}`)
    }
    return row
  }

  return {
    async getDocument(): Promise<SceneDocumentRecord> {
      const row = await requireDocumentRow()
      return mapDocument(row)
    },

    async saveDocument(document: SceneDocument, expectedRev: number): Promise<SceneDocumentRecord> {
      const result = await db
        .update(designDocuments)
        .set({
          document,
          rev: sql`${designDocuments.rev} + 1`,
          updatedAt: new Date(),
        })
        .where(and(
          docScope(),
          eq(designDocuments.rev, expectedRev),
        ))
        .returning()

      if (result.length === 0) {
        // Distinguish stale-rev from missing document so callers get an
        // actionable error message rather than a generic "not found".
        const [existing] = await db.select().from(designDocuments).where(docScope()).limit(1)
        if (!existing) {
          throw new Error(
            `Design document ${scope.documentId} not found in workspace ${scope.workspaceId}`,
          )
        }
        throw new Error(
          `Stale revision: expected rev ${expectedRev} but document is at rev ${existing.rev}. ` +
          `Refetch the document and replay your operations.`,
        )
      }

      const [row] = result
      if (!row) throw new Error('saveDocument UPDATE returned no row')
      return mapDocument(row)
    },

    async recordDecision(input: NewSceneDecision): Promise<SceneDecision> {
      // Verify the document exists in this workspace before writing the FK row.
      await requireDocumentRow()
      const [row] = await db.insert(designDecisions).values({
        documentId: scope.documentId,
        workspaceId: scope.workspaceId,
        kind: input.kind,
        instruction: input.instruction,
        reasoningSummary: input.reasoningSummary ?? null,
        metadata: input.metadata ?? {},
        createdBy: scope.userId,
      }).returning()
      if (!row) throw new Error('design_decision insert returned no row')
      return mapDecision(row)
    },

    async createExport(format: SceneExportFormat, metadata?: Record<string, unknown>): Promise<SceneExportRecord> {
      await requireDocumentRow()
      const [row] = await db.insert(designExports).values({
        documentId: scope.documentId,
        workspaceId: scope.workspaceId,
        format,
        metadata: metadata ?? {},
        createdBy: scope.userId,
      }).returning()
      if (!row) throw new Error('design_export insert returned no row')
      return mapExport(row)
    },

    async listDecisions(limit = DEFAULT_LIST_LIMIT): Promise<SceneDecision[]> {
      assertListLimit(limit)
      const rows = await db.select().from(designDecisions)
        .where(decisionScope())
        .orderBy(desc(designDecisions.createdAt), desc(sql`rowid`))
        .limit(limit)
      return rows.map(mapDecision)
    },

    async listExports(limit = DEFAULT_LIST_LIMIT): Promise<SceneExportRecord[]> {
      assertListLimit(limit)
      const rows = await db.select().from(designExports)
        .where(exportScope())
        .orderBy(desc(designExports.createdAt), desc(sql`rowid`))
        .limit(limit)
      return rows.map(mapExport)
    },
  }
}

// ---------------------------------------------------------------------------
// Row → model mapping. `metadata` is nullable with a `{}` default in the
// schema; SQL NULL and `{}` are both "no metadata" — `?? {}` is a lossless
// representation conversion, not an error-hiding fallback.
// ---------------------------------------------------------------------------

function mapDocument(row: DesignDocumentRow): SceneDocumentRecord {
  return {
    document: row.document,
    rev: row.rev,
  }
}

function mapDecision(row: DesignDecisionRow): SceneDecision {
  return {
    id: row.id,
    kind: row.kind,
    instruction: row.instruction,
    reasoningSummary: row.reasoningSummary,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt,
  }
}

function mapExport(row: DesignExportRow): SceneExportRecord {
  return {
    id: row.id,
    format: row.format,
    status: row.status,
    resultUrl: row.resultUrl,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt,
  }
}

function assertListLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer')
}
