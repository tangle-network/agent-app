/**
 * Drizzle schema factory for the teams tables. The product owns the user and
 * workspace tables; this factory creates the tenancy/membership tables and
 * wires their foreign keys into the passed-in tables so the whole graph lives
 * in one drizzle schema with real cascade semantics. Column names, types,
 * defaults, enums, and indexes mirror gtm's hand-rolled tables so a product
 * with those tables can adopt the factory without rewriting rows.
 *
 * The three tables and their roles:
 *   - `organization` — the TENANT/ownership primitive. `kind` is 'personal'
 *     (one auto-created per user; see ensurePersonalOrganization) or 'team'.
 *     This is what owns workspaces and what billing/seats attach to.
 *   - `organizationMember` — who belongs to an org and at what org role.
 *   - `workspaceMember` — the additive invite/member surface: per-workspace
 *     access grants, including pending email-only invites carrying a token.
 *
 * Imports `drizzle-orm` at module top — that is WHY this lives behind the
 * `/teams/drizzle` sub-subpath. The pure `./teams` leaf imports none of this,
 * so a consumer that never touches the DB never pulls the optional peer.
 */
import type { AnySQLiteColumn, AnySQLiteTable } from 'drizzle-orm/sqlite-core';
/** A product table referenced by FK — only the `id` column is touched. */
export type TeamParentTable = AnySQLiteTable & {
    id: AnySQLiteColumn;
};
/** Define options specifying user and workspace tables for creating team-related tables */
export interface CreateTeamTablesOptions {
    /** The product's user table — org/member rows reference `userTable.id`. */
    userTable: TeamParentTable;
    /** The product's workspace table — workspace members reference `workspaceTable.id`. */
    workspaceTable: TeamParentTable;
}
/** Build SQLite tables for organizations and related team structures using provided options */
export declare function createTeamTables(opts: CreateTeamTablesOptions): {
    organizations: import("drizzle-orm/sqlite-core").SQLiteTableWithColumns<{
        name: "organization";
        schema: undefined;
        columns: {
            id: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "id";
                tableName: "organization";
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
            name: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "name";
                tableName: "organization";
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
            slug: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "slug";
                tableName: "organization";
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
                tableName: "organization";
                dataType: "string";
                columnType: "SQLiteText";
                data: "personal" | "team";
                driverParam: string;
                notNull: true;
                hasDefault: true;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: ["personal", "team"];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            createdBy: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "created_by";
                tableName: "organization";
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
                tableName: "organization";
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
                tableName: "organization";
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
    organizationMembers: import("drizzle-orm/sqlite-core").SQLiteTableWithColumns<{
        name: "organization_member";
        schema: undefined;
        columns: {
            id: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "id";
                tableName: "organization_member";
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
            organizationId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "organization_id";
                tableName: "organization_member";
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
            userId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "user_id";
                tableName: "organization_member";
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
            role: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "role";
                tableName: "organization_member";
                dataType: "string";
                columnType: "SQLiteText";
                data: "admin" | "billing" | "member" | "owner";
                driverParam: string;
                notNull: true;
                hasDefault: true;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: ["owner", "admin", "member", "billing"];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            createdAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "created_at";
                tableName: "organization_member";
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
                tableName: "organization_member";
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
    workspaceMembers: import("drizzle-orm/sqlite-core").SQLiteTableWithColumns<{
        name: "workspace_member";
        schema: undefined;
        columns: {
            id: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "id";
                tableName: "workspace_member";
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
                tableName: "workspace_member";
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
            organizationMemberId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "organization_member_id";
                tableName: "workspace_member";
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
            userId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "user_id";
                tableName: "workspace_member";
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
            role: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "role";
                tableName: "workspace_member";
                dataType: "string";
                columnType: "SQLiteText";
                data: "admin" | "editor" | "owner" | "viewer";
                driverParam: string;
                notNull: true;
                hasDefault: true;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: ["owner", "admin", "editor", "viewer"];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            invitedBy: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "invited_by";
                tableName: "workspace_member";
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
            inviteEmail: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "invite_email";
                tableName: "workspace_member";
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
            inviteToken: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "invite_token";
                tableName: "workspace_member";
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
            invitedAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "invited_at";
                tableName: "workspace_member";
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
            acceptedAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "accepted_at";
                tableName: "workspace_member";
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
/** Resolve team tables by deriving the return type of createTeamTables */
export type TeamTables = ReturnType<typeof createTeamTables>;
/** Resolve the structure of an organization row from the organizations table in TeamTables */
export type OrganizationRow = TeamTables['organizations']['$inferSelect'];
/** Resolve the structure of an organization member row from the team tables selection */
export type OrganizationMemberRow = TeamTables['organizationMembers']['$inferSelect'];
/** Resolve a workspace member row with selected fields from the workspaceMembers table */
export type WorkspaceMemberRow = TeamTables['workspaceMembers']['$inferSelect'];
