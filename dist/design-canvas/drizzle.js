// src/design-canvas/schema.ts
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
var hexId = () => text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`);
var jsonMetadata = () => text("metadata", { mode: "json" }).$type().default({});
var createdAt = () => integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`);
var updatedAt = () => integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`);
function createDesignCanvasTables(opts) {
  const { workspaceTable, userTable } = opts;
  const designDocuments = sqliteTable("design_document", {
    id: hexId(),
    workspaceId: text("workspace_id").notNull().references(() => workspaceTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** Full SceneDocument serialized as JSON — persisted and replaced atomically. */
    document: text("document", { mode: "json" }).$type().notNull(),
    /** Monotonic revision; starts at 1, incremented by every successful save. */
    rev: integer("rev").notNull().default(1),
    /** True when this document is a slot-fillable template for data binding. */
    isTemplate: integer("is_template", { mode: "boolean" }).notNull().default(false),
    createdBy: text("created_by").notNull().references(() => userTable.id),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  }, (table) => [
    index("idx_design_document_workspace_updated").on(table.workspaceId, table.updatedAt),
    index("idx_design_document_workspace_template").on(table.workspaceId, table.isTemplate)
  ]);
  const designDecisions = sqliteTable("design_decision", {
    id: hexId(),
    documentId: text("document_id").notNull().references(() => designDocuments.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull().references(() => workspaceTable.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["human_edit", "agent_edit", "agent_proposal", "export", "note"] }).notNull(),
    instruction: text("instruction").notNull(),
    reasoningSummary: text("reasoning_summary"),
    metadata: jsonMetadata(),
    createdBy: text("created_by").notNull().references(() => userTable.id),
    createdAt: createdAt()
  }, (table) => [
    index("idx_design_decision_document").on(table.documentId, table.createdAt),
    index("idx_design_decision_workspace").on(table.workspaceId)
  ]);
  const designExports = sqliteTable("design_export", {
    id: hexId(),
    documentId: text("document_id").notNull().references(() => designDocuments.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull().references(() => workspaceTable.id, { onDelete: "cascade" }),
    format: text("format", { enum: ["png", "jpeg", "json"] }).notNull(),
    status: text("status", { enum: ["queued", "processing", "completed", "failed"] }).notNull().default("queued"),
    resultUrl: text("result_url"),
    metadata: jsonMetadata(),
    createdBy: text("created_by").notNull().references(() => userTable.id),
    createdAt: createdAt()
  }, (table) => [
    index("idx_design_export_document").on(table.documentId, table.createdAt),
    index("idx_design_export_workspace").on(table.workspaceId)
  ]);
  return { designDocuments, designDecisions, designExports };
}

// src/design-canvas/drizzle-store.ts
import { and, desc, eq, sql as sql2 } from "drizzle-orm";
var DEFAULT_LIST_LIMIT = 50;
function createDrizzleSceneStore(options) {
  const { db, tables, scope } = options;
  const { designDocuments, designDecisions, designExports } = tables;
  const docScope = () => and(
    eq(designDocuments.id, scope.documentId),
    eq(designDocuments.workspaceId, scope.workspaceId)
  );
  const decisionScope = () => and(
    eq(designDecisions.documentId, scope.documentId),
    eq(designDecisions.workspaceId, scope.workspaceId)
  );
  const exportScope = () => and(
    eq(designExports.documentId, scope.documentId),
    eq(designExports.workspaceId, scope.workspaceId)
  );
  async function requireDocumentRow() {
    const [row] = await db.select().from(designDocuments).where(docScope()).limit(1);
    if (!row) {
      throw new Error(`Design document ${scope.documentId} not found in workspace ${scope.workspaceId}`);
    }
    return row;
  }
  return {
    async getDocument() {
      const row = await requireDocumentRow();
      return mapDocument(row);
    },
    async saveDocument(document, expectedRev) {
      const result = await db.update(designDocuments).set({
        document,
        rev: sql2`${designDocuments.rev} + 1`,
        updatedAt: /* @__PURE__ */ new Date()
      }).where(and(
        docScope(),
        eq(designDocuments.rev, expectedRev)
      )).returning();
      if (result.length === 0) {
        const [existing] = await db.select().from(designDocuments).where(docScope()).limit(1);
        if (!existing) {
          throw new Error(
            `Design document ${scope.documentId} not found in workspace ${scope.workspaceId}`
          );
        }
        throw new Error(
          `Stale revision: expected rev ${expectedRev} but document is at rev ${existing.rev}. Refetch the document and replay your operations.`
        );
      }
      const [row] = result;
      if (!row) throw new Error("saveDocument UPDATE returned no row");
      return mapDocument(row);
    },
    async recordDecision(input) {
      await requireDocumentRow();
      const [row] = await db.insert(designDecisions).values({
        documentId: scope.documentId,
        workspaceId: scope.workspaceId,
        kind: input.kind,
        instruction: input.instruction,
        reasoningSummary: input.reasoningSummary ?? null,
        metadata: input.metadata ?? {},
        createdBy: scope.userId
      }).returning();
      if (!row) throw new Error("design_decision insert returned no row");
      return mapDecision(row);
    },
    async createExport(format, metadata) {
      await requireDocumentRow();
      const [row] = await db.insert(designExports).values({
        documentId: scope.documentId,
        workspaceId: scope.workspaceId,
        format,
        metadata: metadata ?? {},
        createdBy: scope.userId
      }).returning();
      if (!row) throw new Error("design_export insert returned no row");
      return mapExport(row);
    },
    async listDecisions(limit = DEFAULT_LIST_LIMIT) {
      assertListLimit(limit);
      const rows = await db.select().from(designDecisions).where(decisionScope()).orderBy(desc(designDecisions.createdAt), desc(sql2`rowid`)).limit(limit);
      return rows.map(mapDecision);
    },
    async listExports(limit = DEFAULT_LIST_LIMIT) {
      assertListLimit(limit);
      const rows = await db.select().from(designExports).where(exportScope()).orderBy(desc(designExports.createdAt), desc(sql2`rowid`)).limit(limit);
      return rows.map(mapExport);
    }
  };
}
function mapDocument(row) {
  return {
    document: row.document,
    rev: row.rev
  };
}
function mapDecision(row) {
  return {
    id: row.id,
    kind: row.kind,
    instruction: row.instruction,
    reasoningSummary: row.reasoningSummary,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt
  };
}
function mapExport(row) {
  return {
    id: row.id,
    format: row.format,
    status: row.status,
    resultUrl: row.resultUrl,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt
  };
}
function assertListLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
}
export {
  createDesignCanvasTables,
  createDrizzleSceneStore
};
//# sourceMappingURL=drizzle.js.map