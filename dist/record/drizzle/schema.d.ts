/**
 * Drizzle table factory for a record-entry table. The product owns its
 * scope (workspace / tenant / account) table; this factory creates the entry
 * table and wires the foreign key into it, so the whole graph lives in one
 * drizzle schema with real cascade semantics.
 *
 * The table NAME is a parameter, so one product can host several independent
 * record tables (different domains, different schema maps) side by side.
 *
 * Three storage invariants are encoded here, and the store depends on all
 * three:
 *
 * 1. **Every key column is NOT NULL with a sentinel.** SQLite treats NULLs as
 *    distinct inside a unique index, so a nullable `item_key` or `dimension`
 *    would let two live heads coexist on one logical key and the partial
 *    unique index below would silently stop enforcing anything. `''` and `0`
 *    are the sentinels; see `RECORD_KEY_SENTINEL` / `RECORD_PERIOD_SENTINEL`.
 * 2. **The live head is unique per key.** The partial unique index covers only
 *    rows that are `accepted` and not superseded, which is exactly the set the
 *    materializer reads. Two writers racing for the same head make the second
 *    one fail loudly instead of both landing.
 * 3. **Ordering is `seq`, never a timestamp.** `created_at` is epoch
 *    milliseconds and is display-only. `(scope_id, seq)` is unique, so the
 *    fold has a total order even for rows written in the same millisecond.
 *
 * `superseded_by_id` deliberately carries NO foreign key: the supersede batch
 * stamps the replacement's id onto the outgoing head BEFORE inserting the
 * replacement row, and SQLite cannot defer the constraint check to allow that
 * order. Rows are append-only and cascade with their scope, so the link cannot
 * dangle.
 */
import type { AnySQLiteColumn, AnySQLiteTable, SQLiteColumnBuilderBase } from 'drizzle-orm/sqlite-core';
import type { RecordReviewState, RecordSourceLocator } from '../model';
/** A product table referenced by foreign key — only its `id` column is used. */
export type RecordParentTable = AnySQLiteTable & {
    id: AnySQLiteColumn;
};
/**
 * Product columns added to the entry table, keyed by the property name the
 * store and the product read them under. Ordinary drizzle column builders, so
 * a product declares foreign keys, defaults and null-ability exactly as it
 * would in its own schema.
 */
export type RecordExtraColumns = Readonly<Record<string, SQLiteColumnBuilderBase>>;
/** Options for {@link createRecordTable}. */
export interface CreateRecordTableOptions {
    /**
     * SQL table name, chosen by the product. Also the default prefix for the
     * index names, so two record tables in one schema never collide.
     */
    tableName: string;
    /**
     * The tenant table entries belong to. Rows cascade with it — deleting a
     * workspace deletes its record.
     */
    scopeTable: RecordParentTable;
    /**
     * Optional table `source_ref` points at (a documents table, a source-record
     * table). Wire it ONLY when every source kind's ref points at this one
     * table; a product whose refs are heterogeneous (a document id for one kind,
     * a message id for another) leaves it off and keeps `source_ref` plain text.
     * When wired, deleting the source sets the ref null and leaves the entry
     * with its quote and locator intact.
     */
    sourceTable?: RecordParentTable;
    /** Optional table `reviewed_by` points at (a users table). */
    reviewerTable?: RecordParentTable;
    /** Index-name prefix. Defaults to {@link tableName}. */
    indexPrefix?: string;
    /**
     * Product columns merged into the table, the `/missions` store-port pattern.
     *
     * The built-in `source_ref` is ONE column, which is right for a store whose
     * refs all point at one table and wrong for one whose kinds cite different
     * things — a chat-sourced row citing a message and a document-sourced row
     * citing a document each want their own foreign key with their own
     * `ON DELETE` behaviour. Declare them here, require them per source kind
     * through `policy.requireExtras`, and pass their values on `write`; the
     * store carries them and reads none of them.
     *
     * A key that collides with a built-in column is refused at construction —
     * silently shadowing `path` or `review_state` would break every invariant
     * the store rests on.
     */
    extraColumns?: RecordExtraColumns;
}
/** Column property names the store owns. An extra column may not take one, and
 *  neither may an `extras` value on a write — shadowing `path` or
 *  `review_state` would break every invariant this table encodes. */
export declare const RECORD_STORE_COLUMNS: ReadonlySet<string>;
/** The base table, built with no spread of a type variable so drizzle infers
 *  the exact row shape {@link RecordEntryRow} is derived from. */
declare function buildRecordEntryTable(options: CreateRecordTableOptions): import("drizzle-orm/sqlite-core").SQLiteTableWithColumns<{
    name: string;
    schema: undefined;
    columns: {
        id: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "id";
            tableName: string;
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
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
        scopeId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "scope_id";
            tableName: string;
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
        seq: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "seq";
            tableName: string;
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
        dimension: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "dimension";
            tableName: string;
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
        period: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "period";
            tableName: string;
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
        path: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "path";
            tableName: string;
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
        itemKey: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "item_key";
            tableName: string;
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
        valueJson: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "value_json";
            tableName: string;
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
        affirmedEmpty: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "affirmed_empty";
            tableName: string;
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
        reviewState: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "review_state";
            tableName: string;
            dataType: "string";
            columnType: "SQLiteText";
            data: RecordReviewState;
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
            $type: RecordReviewState;
        }>;
        conflict: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "conflict";
            tableName: string;
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
        supersededById: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "superseded_by_id";
            tableName: string;
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
        sourceKind: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "source_kind";
            tableName: string;
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
        sourceRef: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "source_ref";
            tableName: string;
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
        sourceLocator: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "source_locator";
            tableName: string;
            dataType: "json";
            columnType: "SQLiteTextJson";
            data: RecordSourceLocator;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: RecordSourceLocator;
        }>;
        sourceQuote: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "source_quote";
            tableName: string;
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
        confidence: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "confidence";
            tableName: string;
            dataType: "number";
            columnType: "SQLiteReal";
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
        reviewedAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "reviewed_at";
            tableName: string;
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
        reviewedBy: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "reviewed_by";
            tableName: string;
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
        createdAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "created_at";
            tableName: string;
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: true;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: 'sqlite';
}>;
/** The table shape {@link createRecordTable} produces. */
export type RecordTable = ReturnType<typeof buildRecordEntryTable>;
/** One stored entry, as selected. */
export type RecordEntryRow = RecordTable['$inferSelect'];
/** The record table plus the product's own columns, so a product's direct
 *  queries name them and the store still sees the shape it depends on. */
export type RecordTableWithExtras<TExtra extends RecordExtraColumns> = RecordTable & {
    readonly [K in keyof TExtra]: AnySQLiteColumn;
};
/**
 * Build one record-entry table wired to the product's tables.
 *
 * The returned table is an ordinary drizzle table: the product puts it in its
 * schema, generates migrations from it, and queries it directly for anything
 * the store does not cover. Declaring `extraColumns` names those columns on
 * the returned type as well.
 */
export declare function createRecordTable<TExtra extends RecordExtraColumns>(options: CreateRecordTableOptions & {
    extraColumns: TExtra;
}): RecordTableWithExtras<TExtra>;
export declare function createRecordTable(options: CreateRecordTableOptions): RecordTable;
export {};
