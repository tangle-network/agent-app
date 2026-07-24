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

import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteColumn, AnySQLiteTable } from 'drizzle-orm/sqlite-core'

/** A product table referenced by FK — only the `id` column is touched. */
export type TeamParentTable = AnySQLiteTable & { id: AnySQLiteColumn }

/** Define options specifying user and workspace tables for creating team-related tables */
export interface CreateTeamTablesOptions {
  /** The product's user table — org/member rows reference `userTable.id`. */
  userTable: TeamParentTable
  /** The product's workspace table — workspace members reference `workspaceTable.id`. */
  workspaceTable: TeamParentTable
}

const hexId = () => text('id').primaryKey().default(sql`(lower(hex(randomblob(16))))`)

const createdAt = () => integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)

const updatedAt = () => integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)

/** Build SQLite tables for organizations and related team structures using provided options */
export function createTeamTables(opts: CreateTeamTablesOptions) {
  const { userTable, workspaceTable } = opts

  const organizations = sqliteTable('organization', {
    id: hexId(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    kind: text('kind', { enum: ['personal', 'team'] }).notNull().default('personal'),
    createdBy: text('created_by').notNull().references(() => userTable.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  }, (table) => [
    index('idx_organization_created_by').on(table.createdBy),
  ])

  const organizationMembers = sqliteTable('organization_member', {
    id: hexId(),
    organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => userTable.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'admin', 'member', 'billing'] }).notNull().default('member'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  }, (table) => [
    uniqueIndex('uniq_org_member_user').on(table.organizationId, table.userId),
    index('idx_org_member_user').on(table.userId),
  ])

  const workspaceMembers = sqliteTable('workspace_member', {
    id: hexId(),
    workspaceId: text('workspace_id').notNull().references(() => workspaceTable.id, { onDelete: 'cascade' }),
    organizationMemberId: text('organization_member_id').references(() => organizationMembers.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => userTable.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'admin', 'editor', 'viewer'] }).notNull().default('editor'),
    invitedBy: text('invited_by'),
    inviteEmail: text('invite_email'),
    inviteToken: text('invite_token'),
    invitedAt: integer('invited_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    acceptedAt: integer('accepted_at', { mode: 'timestamp' }),
  }, (table) => [
    uniqueIndex('uniq_workspace_member_org_member').on(table.workspaceId, table.organizationMemberId),
    index('idx_workspace_member_user').on(table.workspaceId, table.userId),
    index('idx_member_user').on(table.userId),
    uniqueIndex('idx_member_invite_token').on(table.inviteToken),
  ])

  return { organizations, organizationMembers, workspaceMembers }
}

/** Resolve team tables by deriving the return type of createTeamTables */
export type TeamTables = ReturnType<typeof createTeamTables>

/** Resolve the structure of an organization row from the organizations table in TeamTables */
export type OrganizationRow = TeamTables['organizations']['$inferSelect']
/** Resolve the structure of an organization member row from the team tables selection */
export type OrganizationMemberRow = TeamTables['organizationMembers']['$inferSelect']
/** Resolve a workspace member row with selected fields from the workspaceMembers table */
export type WorkspaceMemberRow = TeamTables['workspaceMembers']['$inferSelect']
