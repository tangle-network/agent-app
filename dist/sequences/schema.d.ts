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
import type { AnySQLiteColumn, AnySQLiteTable } from 'drizzle-orm/sqlite-core';
/** A product table referenced by FK — only the `id` column is touched. */
export type SequenceParentTable = AnySQLiteTable & {
    id: AnySQLiteColumn;
};
/** Define options for creating sequence-related database tables including workspace and user tables */
export interface CreateSequenceTablesOptions {
    workspaceTable: SequenceParentTable;
    userTable: SequenceParentTable;
    generationTable?: SequenceParentTable;
    assetTable?: SequenceParentTable;
}
/** Build SQLite sequence tables with defined columns and relationships based on provided options */
export declare function createSequenceTables(opts: CreateSequenceTablesOptions): {
    sequences: import("drizzle-orm/sqlite-core").SQLiteTableWithColumns<{
        name: "sequence";
        schema: undefined;
        columns: {
            id: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "id";
                tableName: "sequence";
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
                tableName: "sequence";
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
                tableName: "sequence";
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
            fps: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "fps";
                tableName: "sequence";
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
            width: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "width";
                tableName: "sequence";
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
            height: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "height";
                tableName: "sequence";
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
            aspectRatio: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "aspect_ratio";
                tableName: "sequence";
                dataType: "string";
                columnType: "SQLiteText";
                data: string;
                driverParam: string;
                notNull: true;
                hasDefault: true;
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
            durationFrames: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "duration_frames";
                tableName: "sequence";
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
            status: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "status";
                tableName: "sequence";
                dataType: "string";
                columnType: "SQLiteText";
                data: "active" | "archived" | "draft" | "exporting";
                driverParam: string;
                notNull: true;
                hasDefault: true;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: ["draft", "active", "exporting", "archived"];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            metadata: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "metadata";
                tableName: "sequence";
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
                tableName: "sequence";
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
                tableName: "sequence";
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
                tableName: "sequence";
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
    sequenceTracks: import("drizzle-orm/sqlite-core").SQLiteTableWithColumns<{
        name: "sequence_track";
        schema: undefined;
        columns: {
            id: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "id";
                tableName: "sequence_track";
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
            sequenceId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "sequence_id";
                tableName: "sequence_track";
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
                tableName: "sequence_track";
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
                tableName: "sequence_track";
                dataType: "string";
                columnType: "SQLiteText";
                data: "agent" | "audio" | "caption" | "reference" | "video";
                driverParam: string;
                notNull: true;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: ["video", "audio", "caption", "reference", "agent"];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            name: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "name";
                tableName: "sequence_track";
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
            sortOrder: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "sort_order";
                tableName: "sequence_track";
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
            locked: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "locked";
                tableName: "sequence_track";
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
            muted: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "muted";
                tableName: "sequence_track";
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
            metadata: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "metadata";
                tableName: "sequence_track";
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
            createdAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "created_at";
                tableName: "sequence_track";
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
    sequenceClips: import("drizzle-orm/sqlite-core").SQLiteTableWithColumns<{
        name: "sequence_clip";
        schema: undefined;
        columns: {
            id: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "id";
                tableName: "sequence_clip";
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
            sequenceId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "sequence_id";
                tableName: "sequence_clip";
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
            trackId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "track_id";
                tableName: "sequence_clip";
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
                tableName: "sequence_clip";
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
            assetId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "asset_id";
                tableName: "sequence_clip";
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
            generationId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "generation_id";
                tableName: "sequence_clip";
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
            label: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "label";
                tableName: "sequence_clip";
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
            startFrame: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "start_frame";
                tableName: "sequence_clip";
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
            durationFrames: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "duration_frames";
                tableName: "sequence_clip";
                dataType: "number";
                columnType: "SQLiteInteger";
                data: number;
                driverParam: number;
                notNull: true;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: undefined;
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {}>;
            sourceInFrame: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "source_in_frame";
                tableName: "sequence_clip";
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
            sourceOutFrame: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "source_out_frame";
                tableName: "sequence_clip";
                dataType: "number";
                columnType: "SQLiteInteger";
                data: number;
                driverParam: number;
                notNull: false;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: undefined;
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {}>;
            version: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "version";
                tableName: "sequence_clip";
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
            disabled: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "disabled";
                tableName: "sequence_clip";
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
            text: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "text";
                tableName: "sequence_clip";
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
            language: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "language";
                tableName: "sequence_clip";
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
                tableName: "sequence_clip";
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
                tableName: "sequence_clip";
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
                tableName: "sequence_clip";
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
                tableName: "sequence_clip";
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
    sequenceDecisions: import("drizzle-orm/sqlite-core").SQLiteTableWithColumns<{
        name: "sequence_decision";
        schema: undefined;
        columns: {
            id: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "id";
                tableName: "sequence_decision";
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
            sequenceId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "sequence_id";
                tableName: "sequence_decision";
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
            clipId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "clip_id";
                tableName: "sequence_decision";
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
            workspaceId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "workspace_id";
                tableName: "sequence_decision";
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
                tableName: "sequence_decision";
                dataType: "string";
                columnType: "SQLiteText";
                data: "agent_edit" | "agent_proposal" | "export" | "human_edit" | "note";
                driverParam: string;
                notNull: true;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: ["human_edit", "agent_proposal", "agent_edit", "export", "note"];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            instruction: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "instruction";
                tableName: "sequence_decision";
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
                tableName: "sequence_decision";
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
            accepted: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "accepted";
                tableName: "sequence_decision";
                dataType: "boolean";
                columnType: "SQLiteBoolean";
                data: boolean;
                driverParam: number;
                notNull: false;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: undefined;
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {}>;
            metadata: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "metadata";
                tableName: "sequence_decision";
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
                tableName: "sequence_decision";
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
                tableName: "sequence_decision";
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
    sequenceExports: import("drizzle-orm/sqlite-core").SQLiteTableWithColumns<{
        name: "sequence_export";
        schema: undefined;
        columns: {
            id: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "id";
                tableName: "sequence_export";
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
                tableName: "sequence_export";
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
            sequenceId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "sequence_id";
                tableName: "sequence_export";
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
                tableName: "sequence_export";
                dataType: "string";
                columnType: "SQLiteText";
                data: "contact_sheet" | "edl" | "mp4" | "otio" | "srt" | "vtt" | "xml";
                driverParam: string;
                notNull: true;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: ["mp4", "otio", "xml", "edl", "vtt", "srt", "contact_sheet"];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            status: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "status";
                tableName: "sequence_export";
                dataType: "string";
                columnType: "SQLiteText";
                data: "cancelled" | "completed" | "failed" | "processing" | "queued";
                driverParam: string;
                notNull: true;
                hasDefault: true;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: ["queued", "processing", "completed", "failed", "cancelled"];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            resultUrl: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "result_url";
                tableName: "sequence_export";
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
                tableName: "sequence_export";
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
                tableName: "sequence_export";
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
                tableName: "sequence_export";
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
            completedAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "completed_at";
                tableName: "sequence_export";
                dataType: "date";
                columnType: "SQLiteTimestamp";
                data: Date;
                driverParam: number;
                notNull: false;
                hasDefault: false;
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
/** Resolve sequence tables by invoking the createSequenceTables factory function */
export type SequenceTables = ReturnType<typeof createSequenceTables>;
/** Resolve a sequence row by inferring the selected fields from the sequences table */
export type SequenceRow = SequenceTables['sequences']['$inferSelect'];
/** Resolve the selected sequence track row from the sequenceTracks table */
export type SequenceTrackRow = SequenceTables['sequenceTracks']['$inferSelect'];
/** Resolve the selected fields of sequence clips from the sequence tables data structure */
export type SequenceClipRow = SequenceTables['sequenceClips']['$inferSelect'];
/** Resolve a sequence decision row from the sequenceDecisions table data */
export type SequenceDecisionRow = SequenceTables['sequenceDecisions']['$inferSelect'];
/** Resolve a row type representing exported sequence data from sequenceExports table */
export type SequenceExportRow = SequenceTables['sequenceExports']['$inferSelect'];
