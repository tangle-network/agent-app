/**
 * RBAC access builders over the teams tables. `createWorkspaceAccess` and
 * `createOrganizationAccess` close over the product's `db`, the tables from
 * `createTeamTables`, and the product's `workspace` table, returning the exact
 * `getWorkspaceAccess` / `requireWorkspaceAccess` / `listUserWorkspaces` /
 * `getOrganizationAccess` / `requireOrganizationAccess` functions a consumer
 * already calls — so adoption is a one-line import swap, every call site stays
 * identical.
 *
 * Defense in depth: org owners/admins are workspace owners across the org;
 * everyone else gets their explicit per-workspace role. Effective role is the
 * fold in `resolveWorkspaceRole` (pure, from `../roles`). Every query pins
 * `userId`, so a leaked id can never read across the tenancy boundary — it
 * surfaces as "not found".
 *
 * Driver-agnostic: builders are awaited, never `.run()`/`.all()`, so
 * better-sqlite3, D1, and libsql handles all behave identically.
 */
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { type OrganizationRole, type WorkspaceRole } from '../roles';
import type { TeamParentTable } from './schema';
import type { OrganizationMemberRow, OrganizationRow, TeamTables } from './schema';
/** Any SQLite drizzle database — `any` erases driver-specific generics so
 *  better-sqlite3, D1, and libsql handles all fit. */
export type TeamDatabase = BaseSQLiteDatabase<'sync' | 'async', any, any>;
/**
 * The product's workspace table, narrowed to the columns the access joins read.
 * Adopters pass their real drizzle workspace table — it carries these columns
 * (gtm's does); the type only asserts the minimum the joins touch.
 */
export interface WorkspaceAccessTable {
    id: any;
    organizationId: any;
    name: any;
    updatedAt: any;
}
/** Define options required to create access with database, tables, and workspace table references */
export interface CreateAccessOptions {
    db: TeamDatabase;
    tables: TeamTables;
    /** The product's workspace table (the FK target passed to createTeamTables). */
    workspaceTable: TeamParentTable & WorkspaceAccessTable;
}
/** Define access details including workspace data, organization info, member info, and role within workspace */
export interface WorkspaceAccess {
    workspace: Record<string, unknown>;
    organization: OrganizationRow;
    organizationMember: OrganizationMemberRow;
    role: WorkspaceRole;
}
/** Describe a user's workspace details including organization and role information */
export interface UserWorkspaceSummary extends Record<string, unknown> {
    organizationId: string;
    organizationName: string;
    role: WorkspaceRole;
}
/** Define methods to retrieve and enforce user access permissions within workspaces */
export interface WorkspaceAccessApi {
    getWorkspaceAccess(workspaceId: string, userId: string, minRole?: WorkspaceRole): Promise<WorkspaceAccess | null>;
    requireWorkspaceAccess(workspaceId: string, userId: string, minRole?: WorkspaceRole): Promise<WorkspaceAccess>;
    listUserWorkspaces(userId: string): Promise<UserWorkspaceSummary[]>;
}
/** Create workspace access API to manage user roles and permissions within a workspace */
export declare function createWorkspaceAccess(opts: CreateAccessOptions): WorkspaceAccessApi;
/** Define access details linking an organization, its member, and the member's role */
export interface OrganizationAccess {
    organization: OrganizationRow;
    member: OrganizationMemberRow;
    role: OrganizationRole;
}
/** Define methods to retrieve and enforce user access levels within an organization */
export interface OrganizationAccessApi {
    getOrganizationAccess(organizationId: string, userId: string, minRole?: OrganizationRole): Promise<OrganizationAccess | null>;
    requireOrganizationAccess(organizationId: string, userId: string, minRole?: OrganizationRole): Promise<OrganizationAccess>;
}
/** Define options required to create access for an organization including database and tables */
export interface CreateOrganizationAccessOptions {
    db: TeamDatabase;
    tables: TeamTables;
}
/** Resolve organization access API with specified database and table options */
export declare function createOrganizationAccess(opts: CreateOrganizationAccessOptions): OrganizationAccessApi;
