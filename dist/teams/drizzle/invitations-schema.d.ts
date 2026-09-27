/**
 * Drizzle schema factory for the dedicated workspace-invitation table. Separate
 * from `createTeamTables` on purpose: an app opts into the rich email-invitation
 * lifecycle (status / expiry / resend / revoke / preview) by calling this, and an
 * app that doesn't want it never grows the table — `createTeamTables`'s output and
 * migrations stay untouched.
 *
 * The product owns the user and workspace tables; `organizations` comes from
 * `createTeamTables`. Pass all three so the invitation's FKs wire into the same
 * drizzle schema with real cascade semantics. Call this AFTER `createTeamTables`
 * (so `organizations` exists) — the lazy `.references(() => ...)` closures make
 * the ordering within one module safe.
 *
 * Columns / enums / indexes mirror creative-agent's validated hand-rolled table,
 * so an app already running that table adopts this factory with no row rewrite.
 */
import type { TeamParentTable } from './schema';
/** Define options for creating a workspace invitation table with user, workspace, and organization references */
export interface CreateWorkspaceInvitationTableOptions {
    /** The product's user table — `invitedByUserId` references `userTable.id`. */
    userTable: TeamParentTable;
    /** The product's workspace table — `workspaceId` references `workspaceTable.id`. */
    workspaceTable: TeamParentTable;
    /** The `organizations` table from `createTeamTables` — `organizationId` references it. */
    organizationTable: TeamParentTable;
}
/** Build a workspace invitation table with defined columns and foreign key constraints */
export declare function createWorkspaceInvitationTable(opts: CreateWorkspaceInvitationTableOptions): {
    workspaceInvitations: import("drizzle-orm/sqlite-core").SQLiteTableWithColumns<{
        name: "workspace_invitation";
        schema: undefined;
        columns: {
            id: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "id";
                tableName: "workspace_invitation";
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
                tableName: "workspace_invitation";
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
            organizationId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "organization_id";
                tableName: "workspace_invitation";
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
            email: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "email";
                tableName: "workspace_invitation";
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
            invitedByUserId: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "invited_by_user_id";
                tableName: "workspace_invitation";
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
            permissions: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "permissions";
                tableName: "workspace_invitation";
                dataType: "string";
                columnType: "SQLiteText";
                data: "admin" | "editor" | "viewer";
                driverParam: string;
                notNull: true;
                hasDefault: true;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: ["admin", "editor", "viewer"];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            token: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "token";
                tableName: "workspace_invitation";
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
            status: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "status";
                tableName: "workspace_invitation";
                dataType: "string";
                columnType: "SQLiteText";
                data: "accepted" | "expired" | "pending" | "revoked";
                driverParam: string;
                notNull: true;
                hasDefault: true;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: ["pending", "accepted", "expired", "revoked"];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            emailStatus: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "email_status";
                tableName: "workspace_invitation";
                dataType: "string";
                columnType: "SQLiteText";
                data: "failed" | "not_sent" | "sent";
                driverParam: string;
                notNull: true;
                hasDefault: true;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: ["not_sent", "sent", "failed"];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            expiresAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "expires_at";
                tableName: "workspace_invitation";
                dataType: "date";
                columnType: "SQLiteTimestamp";
                data: Date;
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
            createdAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "created_at";
                tableName: "workspace_invitation";
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
                tableName: "workspace_invitation";
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
            revokedAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "revoked_at";
                tableName: "workspace_invitation";
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
            lastSentAt: import("drizzle-orm/sqlite-core").SQLiteColumn<{
                name: "last_sent_at";
                tableName: "workspace_invitation";
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
/** Resolve the structure of workspace invitation tables from the creation function */
export type WorkspaceInvitationTables = ReturnType<typeof createWorkspaceInvitationTable>;
/** Resolve the structure of a workspace invitation row from the workspaceInvitations table */
export type WorkspaceInvitationRow = WorkspaceInvitationTables['workspaceInvitations']['$inferSelect'];
