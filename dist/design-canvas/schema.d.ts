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
import type { AnySQLiteColumn, AnySQLiteTable } from 'drizzle-orm/sqlite-core';
import type { SceneDocument } from './model';
/** A product table referenced by FK — only the `id` column is touched. */
export type DesignCanvasParentTable = AnySQLiteTable & {
    id: AnySQLiteColumn;
};
/** Define options for creating design canvas tables including workspace and user table configurations */
export interface CreateDesignCanvasTablesOptions {
    workspaceTable: DesignCanvasParentTable;
    userTable: DesignCanvasParentTable;
}
/** Build SQLite tables for design documents with workspace and user references */
export declare function createDesignCanvasTables(opts: CreateDesignCanvasTablesOptions): {
    designDocuments: import("drizzle-orm/sqlite-core").SQLiteTableWithColumns<{
        name: "design_document";
        schema: undefined;
        columns: {
            id: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "id";
                tableName: "design_document";
                dataType: "string";
                columnType: "SQLiteText";
                data: string;
                driverParam: string;
                notNull: true;
                hasDefault: true;
                isPrimaryKey: true;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [string, ...string[]];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            workspaceId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "workspace_id";
                tableName: "design_document";
                dataType: "string";
                columnType: "SQLiteText";
                data: string;
                driverParam: string;
                notNull: true;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [string, ...string[]];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            title: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "title";
                tableName: "design_document";
                dataType: "string";
                columnType: "SQLiteText";
                data: string;
                driverParam: string;
                notNull: true;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [string, ...string[]];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            document: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "document";
                tableName: "design_document";
                dataType: "json";
                columnType: "SQLiteTextJson";
                data: SceneDocument;
                driverParam: string;
                notNull: true;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: undefined;
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                $type: SceneDocument;
            }>;
            rev: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "rev";
                tableName: "design_document";
                dataType: "number";
                columnType: "SQLiteInteger";
                data: number;
                driverParam: number;
                notNull: true;
                hasDefault: true;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: undefined;
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {}>;
            isTemplate: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "is_template";
                tableName: "design_document";
                dataType: "boolean";
                columnType: "SQLiteBoolean";
                data: boolean;
                driverParam: number;
                notNull: true;
                hasDefault: true;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: undefined;
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {}>;
            createdBy: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "created_by";
                tableName: "design_document";
                dataType: "string";
                columnType: "SQLiteText";
                data: string;
                driverParam: string;
                notNull: true;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [string, ...string[]];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            createdAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "created_at";
                tableName: "design_document";
                dataType: "date";
                columnType: "SQLiteTimestamp";
                data: Date;
                driverParam: number;
                notNull: true;
                hasDefault: true;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: undefined;
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {}>;
            updatedAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "updated_at";
                tableName: "design_document";
                dataType: "date";
                columnType: "SQLiteTimestamp";
                data: Date;
                driverParam: number;
                notNull: true;
                hasDefault: true;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: undefined;
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {}>;
        };
        dialect: 'sqlite';
    }>;
    designDecisions: import("drizzle-orm/sqlite-core").SQLiteTableWithColumns<{
        name: "design_decision";
        schema: undefined;
        columns: {
            id: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "id";
                tableName: "design_decision";
                dataType: "string";
                columnType: "SQLiteText";
                data: string;
                driverParam: string;
                notNull: true;
                hasDefault: true;
                isPrimaryKey: true;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [string, ...string[]];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            documentId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "document_id";
                tableName: "design_decision";
                dataType: "string";
                columnType: "SQLiteText";
                data: string;
                driverParam: string;
                notNull: true;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [string, ...string[]];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            workspaceId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "workspace_id";
                tableName: "design_decision";
                dataType: "string";
                columnType: "SQLiteText";
                data: string;
                driverParam: string;
                notNull: true;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [string, ...string[]];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            kind: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "kind";
                tableName: "design_decision";
                dataType: "string";
                columnType: "SQLiteText";
                data: "agent_edit" | "agent_proposal" | "export" | "human_edit" | "note";
                driverParam: string;
                notNull: true;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: ["human_edit", "agent_edit", "agent_proposal", "export", "note"];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            instruction: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "instruction";
                tableName: "design_decision";
                dataType: "string";
                columnType: "SQLiteText";
                data: string;
                driverParam: string;
                notNull: true;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [string, ...string[]];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            reasoningSummary: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "reasoning_summary";
                tableName: "design_decision";
                dataType: "string";
                columnType: "SQLiteText";
                data: string;
                driverParam: string;
                notNull: false;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [string, ...string[]];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            metadata: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "metadata";
                tableName: "design_decision";
                dataType: "json";
                columnType: "SQLiteTextJson";
                data: Record<string, unknown>;
                driverParam: string;
                notNull: false;
                hasDefault: true;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: undefined;
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                $type: Record<string, unknown>;
            }>;
            createdBy: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "created_by";
                tableName: "design_decision";
                dataType: "string";
                columnType: "SQLiteText";
                data: string;
                driverParam: string;
                notNull: true;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [string, ...string[]];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            createdAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "created_at";
                tableName: "design_decision";
                dataType: "date";
                columnType: "SQLiteTimestamp";
                data: Date;
                driverParam: number;
                notNull: true;
                hasDefault: true;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: undefined;
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {}>;
        };
        dialect: 'sqlite';
    }>;
    designExports: import("drizzle-orm/sqlite-core").SQLiteTableWithColumns<{
        name: "design_export";
        schema: undefined;
        columns: {
            id: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "id";
                tableName: "design_export";
                dataType: "string";
                columnType: "SQLiteText";
                data: string;
                driverParam: string;
                notNull: true;
                hasDefault: true;
                isPrimaryKey: true;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [string, ...string[]];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            documentId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "document_id";
                tableName: "design_export";
                dataType: "string";
                columnType: "SQLiteText";
                data: string;
                driverParam: string;
                notNull: true;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [string, ...string[]];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            workspaceId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "workspace_id";
                tableName: "design_export";
                dataType: "string";
                columnType: "SQLiteText";
                data: string;
                driverParam: string;
                notNull: true;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [string, ...string[]];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            format: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "format";
                tableName: "design_export";
                dataType: "string";
                columnType: "SQLiteText";
                data: "jpeg" | "json" | "png";
                driverParam: string;
                notNull: true;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: ["png", "jpeg", "json"];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            status: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "status";
                tableName: "design_export";
                dataType: "string";
                columnType: "SQLiteText";
                data: "completed" | "failed" | "processing" | "queued";
                driverParam: string;
                notNull: true;
                hasDefault: true;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: ["queued", "processing", "completed", "failed"];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            resultUrl: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "result_url";
                tableName: "design_export";
                dataType: "string";
                columnType: "SQLiteText";
                data: string;
                driverParam: string;
                notNull: false;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [string, ...string[]];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            metadata: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "metadata";
                tableName: "design_export";
                dataType: "json";
                columnType: "SQLiteTextJson";
                data: Record<string, unknown>;
                driverParam: string;
                notNull: false;
                hasDefault: true;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: undefined;
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                $type: Record<string, unknown>;
            }>;
            createdBy: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "created_by";
                tableName: "design_export";
                dataType: "string";
                columnType: "SQLiteText";
                data: string;
                driverParam: string;
                notNull: true;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [string, ...string[]];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            createdAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "created_at";
                tableName: "design_export";
                dataType: "date";
                columnType: "SQLiteTimestamp";
                data: Date;
                driverParam: number;
                notNull: true;
                hasDefault: true;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: undefined;
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {}>;
        };
        dialect: 'sqlite';
    }>;
};
/** Resolve the structure and data of design canvas tables for rendering and manipulation */
export type DesignCanvasTables = ReturnType<typeof createDesignCanvasTables>;
/** Resolve the selected structure of a design document row from design canvas tables */
export type DesignDocumentRow = DesignCanvasTables['designDocuments']['$inferSelect'];
/** Resolve a design decision row from the design decisions table selection */
export type DesignDecisionRow = DesignCanvasTables['designDecisions']['$inferSelect'];
/** Resolve the selected fields of designExports from DesignCanvasTables */
export type DesignExportRow = DesignCanvasTables['designExports']['$inferSelect'];
