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

import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { TeamParentTable } from './schema'

export interface CreateWorkspaceInvitationTableOptions {
  /** The product's user table — `invitedByUserId` references `userTable.id`. */
  userTable: TeamParentTable
  /** The product's workspace table — `workspaceId` references `workspaceTable.id`. */
  workspaceTable: TeamParentTable
  /** The `organizations` table from `createTeamTables` — `organizationId` references it. */
  organizationTable: TeamParentTable
}

export function createWorkspaceInvitationTable(opts: CreateWorkspaceInvitationTableOptions) {
  const { userTable, workspaceTable, organizationTable } = opts

  const workspaceInvitations = sqliteTable('workspace_invitation', {
    id: text('id').primaryKey().default(sql`(lower(hex(randomblob(16))))`),
    workspaceId: text('workspace_id').notNull().references(() => workspaceTable.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull().references(() => organizationTable.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    invitedByUserId: text('invited_by_user_id').notNull().references(() => userTable.id, { onDelete: 'cascade' }),
    permissions: text('permissions', { enum: ['admin', 'editor', 'viewer'] }).notNull().default('editor'),
    token: text('token').notNull().unique(),
    status: text('status', { enum: ['pending', 'accepted', 'expired', 'revoked'] }).notNull().default('pending'),
    emailStatus: text('email_status', { enum: ['not_sent', 'sent', 'failed'] }).notNull().default('not_sent'),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    acceptedAt: integer('accepted_at', { mode: 'timestamp' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
    lastSentAt: integer('last_sent_at', { mode: 'timestamp' }),
  }, (table) => [
    uniqueIndex('uniq_workspace_invitation_token').on(table.token),
    index('idx_workspace_invitation_workspace').on(table.workspaceId, table.createdAt),
    index('idx_workspace_invitation_email').on(table.email),
    index('idx_workspace_invitation_workspace_email_status').on(table.workspaceId, table.email, table.status),
  ])

  return { workspaceInvitations }
}

export type WorkspaceInvitationTables = ReturnType<typeof createWorkspaceInvitationTable>
export type WorkspaceInvitationRow = WorkspaceInvitationTables['workspaceInvitations']['$inferSelect']
