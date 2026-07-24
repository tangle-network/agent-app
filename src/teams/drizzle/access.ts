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

import { and, desc, eq, isNotNull } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import {
  type OrganizationRole,
  type WorkspaceRole,
  hasOrganizationRole,
  hasWorkspaceRole,
  resolveWorkspaceRole,
} from '../roles'
import type { TeamParentTable } from './schema'
import type { OrganizationMemberRow, OrganizationRow, TeamTables } from './schema'

/** Any SQLite drizzle database — `any` erases driver-specific generics so
 *  better-sqlite3, D1, and libsql handles all fit. */
export type TeamDatabase = BaseSQLiteDatabase<'sync' | 'async', any, any>

/**
 * The product's workspace table, narrowed to the columns the access joins read.
 * Adopters pass their real drizzle workspace table — it carries these columns
 * (gtm's does); the type only asserts the minimum the joins touch.
 */
export interface WorkspaceAccessTable {
  id: any
  organizationId: any
  name: any
  updatedAt: any
}

/** Define options required to create access with database, tables, and workspace table references */
export interface CreateAccessOptions {
  db: TeamDatabase
  tables: TeamTables
  /** The product's workspace table (the FK target passed to createTeamTables). */
  workspaceTable: TeamParentTable & WorkspaceAccessTable
}

/** Define access details including workspace data, organization info, member info, and role within workspace */
export interface WorkspaceAccess {
  workspace: Record<string, unknown>
  organization: OrganizationRow
  organizationMember: OrganizationMemberRow
  role: WorkspaceRole
}

/** Describe a user's workspace details including organization and role information */
export interface UserWorkspaceSummary extends Record<string, unknown> {
  organizationId: string
  organizationName: string
  role: WorkspaceRole
}

/** Define methods to retrieve and enforce user access permissions within workspaces */
export interface WorkspaceAccessApi {
  getWorkspaceAccess(workspaceId: string, userId: string, minRole?: WorkspaceRole): Promise<WorkspaceAccess | null>
  requireWorkspaceAccess(workspaceId: string, userId: string, minRole?: WorkspaceRole): Promise<WorkspaceAccess>
  listUserWorkspaces(userId: string): Promise<UserWorkspaceSummary[]>
}

/** Create workspace access API to manage user roles and permissions within a workspace */
export function createWorkspaceAccess(opts: CreateAccessOptions): WorkspaceAccessApi {
  const { db, tables, workspaceTable } = opts
  const { organizations, organizationMembers, workspaceMembers } = tables
  const workspaces = workspaceTable

  async function getWorkspaceAccess(
    workspaceId: string,
    userId: string,
    minRole: WorkspaceRole = 'viewer',
  ): Promise<WorkspaceAccess | null> {
    const [row] = await db
      .select({
        workspace: workspaces,
        organization: organizations,
        organizationMember: organizationMembers,
        projectRole: workspaceMembers.role,
        acceptedAt: workspaceMembers.acceptedAt,
      })
      .from(workspaces)
      .innerJoin(organizations, eq(organizations.id, workspaces.organizationId))
      .innerJoin(organizationMembers, and(
        eq(organizationMembers.organizationId, workspaces.organizationId),
        eq(organizationMembers.userId, userId),
      ))
      .leftJoin(workspaceMembers, and(
        eq(workspaceMembers.workspaceId, workspaces.id),
        eq(workspaceMembers.organizationMemberId, organizationMembers.id),
        isNotNull(workspaceMembers.acceptedAt),
      ))
      .where(eq(workspaces.id, workspaceId))
      .limit(1)

    if (!row) return null

    const role = resolveWorkspaceRole(row.organizationMember.role, row.projectRole as WorkspaceRole | null)
    if (!role) return null
    if (!hasWorkspaceRole(role, minRole)) return null

    return {
      workspace: row.workspace as Record<string, unknown>,
      organization: row.organization,
      organizationMember: row.organizationMember,
      role,
    }
  }

  async function requireWorkspaceAccess(
    workspaceId: string,
    userId: string,
    minRole: WorkspaceRole = 'viewer',
  ): Promise<WorkspaceAccess> {
    const access = await getWorkspaceAccess(workspaceId, userId, minRole)
    if (!access) throw new Response('Workspace not found', { status: 404 })
    return access
  }

  async function listUserWorkspaces(userId: string): Promise<UserWorkspaceSummary[]> {
    const rows = await db
      .select({
        workspace: workspaces,
        organization: organizations,
        organizationMember: organizationMembers,
        projectRole: workspaceMembers.role,
      })
      .from(workspaces)
      .innerJoin(organizations, eq(organizations.id, workspaces.organizationId))
      .innerJoin(organizationMembers, and(
        eq(organizationMembers.organizationId, workspaces.organizationId),
        eq(organizationMembers.userId, userId),
      ))
      .leftJoin(workspaceMembers, and(
        eq(workspaceMembers.workspaceId, workspaces.id),
        eq(workspaceMembers.organizationMemberId, organizationMembers.id),
        isNotNull(workspaceMembers.acceptedAt),
      ))
      // Most recently active workspace first, so callers taking rows[0] as the
      // default pick the freshest one.
      .orderBy(desc(workspaces.updatedAt))

    return rows.flatMap((row: any) => {
      const role = resolveWorkspaceRole(row.organizationMember.role, row.projectRole as WorkspaceRole | null)
      if (!role) return []
      return [{
        ...(row.workspace as Record<string, unknown>),
        organizationId: row.organization.id,
        organizationName: row.organization.name,
        role,
      } as UserWorkspaceSummary]
    })
  }

  return { getWorkspaceAccess, requireWorkspaceAccess, listUserWorkspaces }
}

/** Define access details linking an organization, its member, and the member's role */
export interface OrganizationAccess {
  organization: OrganizationRow
  member: OrganizationMemberRow
  role: OrganizationRole
}

/** Define methods to retrieve and enforce user access levels within an organization */
export interface OrganizationAccessApi {
  getOrganizationAccess(organizationId: string, userId: string, minRole?: OrganizationRole): Promise<OrganizationAccess | null>
  requireOrganizationAccess(organizationId: string, userId: string, minRole?: OrganizationRole): Promise<OrganizationAccess>
}

/** Define options required to create access for an organization including database and tables */
export interface CreateOrganizationAccessOptions {
  db: TeamDatabase
  tables: TeamTables
}

/** Resolve organization access API with specified database and table options */
export function createOrganizationAccess(opts: CreateOrganizationAccessOptions): OrganizationAccessApi {
  const { db, tables } = opts
  const { organizations, organizationMembers } = tables

  async function getOrganizationAccess(
    organizationId: string,
    userId: string,
    minRole: OrganizationRole = 'member',
  ): Promise<OrganizationAccess | null> {
    const [row] = await db
      .select({
        organization: organizations,
        member: organizationMembers,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ))
      .limit(1)

    if (!row) return null
    const role = row.member.role as OrganizationRole
    if (!hasOrganizationRole(role, minRole)) return null
    return { organization: row.organization, member: row.member, role }
  }

  async function requireOrganizationAccess(
    organizationId: string,
    userId: string,
    minRole: OrganizationRole = 'member',
  ): Promise<OrganizationAccess> {
    const access = await getOrganizationAccess(organizationId, userId, minRole)
    if (!access) throw new Response('Organization not found', { status: 404 })
    return access
  }

  return { getOrganizationAccess, requireOrganizationAccess }
}
