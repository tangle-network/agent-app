/**
 * Drizzle schema factory for the intake tables. The product owns the user (and
 * optionally workspace) tables; this factory creates the intake tables and
 * wires their foreign keys into the passed-in tables so the whole graph lives
 * in one drizzle schema with real cascade semantics.
 *
 * Two tables, two scopes:
 *   - `user_intake`    — the one-time onboarding interview, keyed on `user.id`
 *     (UNIQUE per user: one onboarding payload per user). ALWAYS created.
 *   - `project_intake` — the structured intake attached to a workspace, keyed
 *     on `workspace.id` (UNIQUE per workspace). Created ONLY when a
 *     `workspaceTable` is passed.
 *
 * `workspaceTable` is OPTIONAL by design: a non-workspace app (a single-user
 * tool, tax-without-workspaces) adopts per-user onboarding alone with zero
 * teams and zero workspace concept. When omitted, `createIntakeTables` returns
 * `{ userIntake }` and no `projectIntake` — the FK to a workspace table that
 * does not exist is never created.
 *
 * Imports `drizzle-orm` at module top — that is WHY this lives behind the
 * `/intakes/drizzle` sub-subpath. The pure `./intakes` leaf imports none of
 * this, so a consumer that never touches the DB never pulls the optional peer.
 */
import type { AnySQLiteColumn, AnySQLiteTable } from 'drizzle-orm/sqlite-core';
/** A product table referenced by FK — only the `id` column is touched. */
export type IntakeParentTable = AnySQLiteTable & {
    id: AnySQLiteColumn;
};
/** Define options for creating intake tables including user and optional workspace references */
export interface CreateIntakeTablesOptions {
    /** The product's user table — user-intake rows reference `userTable.id`. */
    userTable: IntakeParentTable;
    /**
     * The product's workspace table — project-intake rows reference
     * `workspaceTable.id`. OPTIONAL: omit it for a single-user / non-workspace
     * app that wants per-user onboarding only. When omitted, no `projectIntake`
     * table is created.
     */
    workspaceTable?: IntakeParentTable;
}
declare function createUserIntakeTable(userTable: IntakeParentTable): import("drizzle-orm/sqlite-core").SQLiteTableWithColumns<{
    name: "user_intake";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "id";
            tableName: "user_intake";
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
        userId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "user_id";
            tableName: "user_intake";
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
        graphId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "graph_id";
            tableName: "user_intake";
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
        payload: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "payload";
            tableName: "user_intake";
            dataType: "json";
            columnType: "SQLiteTextJson";
            data: unknown;
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
        }, {}, {}>;
        completedAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "completed_at";
            tableName: "user_intake";
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
        createdAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "created_at";
            tableName: "user_intake";
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
            tableName: "user_intake";
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
declare function createProjectIntakeTable(workspaceTable: IntakeParentTable): import("drizzle-orm/sqlite-core").SQLiteTableWithColumns<{
    name: "project_intake";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "id";
            tableName: "project_intake";
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
            tableName: "project_intake";
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
        graphId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "graph_id";
            tableName: "project_intake";
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
        payload: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "payload";
            tableName: "project_intake";
            dataType: "json";
            columnType: "SQLiteTextJson";
            data: unknown;
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
        }, {}, {}>;
        completedAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "completed_at";
            tableName: "project_intake";
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
        createdAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
            name: "created_at";
            tableName: "project_intake";
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
            tableName: "project_intake";
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
/**
 * Build the intake tables wired to the product's tables. Always returns
 * `userIntake`; returns `projectIntake` only when `workspaceTable` is passed.
 * The return type carries `projectIntake?` so a consumer that passes no
 * workspace table cannot reference a table that does not exist.
 */
export declare function createIntakeTables<O extends CreateIntakeTablesOptions>(opts: O): IntakeTables<O>;
/** Resolve the structure and data of a user intake table based on the createUserIntakeTable function */
export type UserIntakeTable = ReturnType<typeof createUserIntakeTable>;
/** Resolve the structure and data of the project intake table from the factory function */
export type ProjectIntakeTable = ReturnType<typeof createProjectIntakeTable>;
/**
 * The tables returned for a given options shape: `projectIntake` is present in
 * the type exactly when `workspaceTable` was provided.
 */
export type IntakeTables<O extends CreateIntakeTablesOptions> = O extends {
    workspaceTable: IntakeParentTable;
} ? {
    userIntake: UserIntakeTable;
    projectIntake: ProjectIntakeTable;
} : {
    userIntake: UserIntakeTable;
    projectIntake?: ProjectIntakeTable;
};
/** The union table shape, for code that handles either scope generically. */
export type AnyIntakeTables = {
    userIntake: UserIntakeTable;
    projectIntake?: ProjectIntakeTable;
};
/** Infer and represent a selected row from the UserIntakeTable data structure */
export type UserIntakeRow = UserIntakeTable['$inferSelect'];
/** Resolve the selected data structure for a project intake table row */
export type ProjectIntakeRow = ProjectIntakeTable['$inferSelect'];
export {};
