/**
 * Framework-neutral email-invitation lifecycle for the teams module: create /
 * list / resend / revoke / preview / accept over the dedicated
 * `workspace_invitation` table (from `createWorkspaceInvitationTable`). Lifted out
 * of any one app's route file — each app binds this once to its own db/tables/
 * access and mounts the handlers in its own routes with its own auth.
 *
 * Unlike `members-api` (whose "invite" is a pending workspaceMember row, no
 * email), this models the rich lifecycle: a dedicated invitation row with status,
 * 7-day expiry, emailStatus, resend, and revoke. On accept it materializes the
 * `organizationMembers` + `workspaceMembers` rows, so `members-api.listMembers`
 * still surfaces accepted members; pending invites live only here.
 *
 * Handlers return a discriminated `InvitationOutcome` (not a `Response`) so the
 * route adapter maps `{ status }` to its own framework's response. Three seams:
 *   - `sendInvitationEmail` (REQUIRED) — the app's mail transport. Returns a
 *     typed outcome; a failed send never blocks invitation creation (emailStatus
 *     is recorded as 'failed' and the invite link is still returned).
 *   - `enforceSeat` (OPTIONAL) — billing/seat-limit gate, called at create time
 *     only when the invite would consume a NEW seat. Reused from members-api.
 *   - `memberSyncSeam.add` (OPTIONAL) — fire-and-forget propagation of the new
 *     member to a sandbox/external system on accept. Fail-soft by contract.
 *
 * Imports `drizzle-orm`, so this is a subpath, never re-exported from root.
 */

import { and, eq, lte, sql } from 'drizzle-orm'
import {
  type InvitationEmailStatus,
  type InvitationPermission,
  type InvitationStatus,
  generateInvitationToken,
  getInvitationExpiresAt,
  inviteUrlForToken,
  normalizeInvitationEmail,
  parseInvitationPermission,
} from './invitations'
import { type WorkspaceRole, hasWorkspaceRole } from './roles'
import { type EnforceSeatSeam, type MemberSyncSeam, SeatLimitError } from './members-api'
import type { TeamDatabase, WorkspaceAccessApi } from './drizzle/access'
import type { TeamParentTable, TeamTables } from './drizzle/schema'
import type { WorkspaceInvitationRow, WorkspaceInvitationTables } from './drizzle/invitations-schema'

// Re-export the seams an adopter wires, so a consumer can import everything the
// invitations API needs from this one subpath.
export { SeatLimitError } from './members-api'
export type { EnforceSeatSeam, MemberSyncSeam } from './members-api'

/** The app's mail transport. Returns a typed outcome; never throws to the API. */
export interface SendInvitationEmailInput {
  to: string
  workspaceName: string
  inviterEmail: string
  permission: InvitationPermission
  inviteUrl: string
  expiresAt: Date
}
/** Represent the outcome of sending an invitation email with success status and optional error message */
export type SendInvitationEmailResult = { succeeded: true } | { succeeded: false; error: string }
/** Resolve sending an invitation email and return the result asynchronously */
export interface SendInvitationEmailSeam {
  (input: SendInvitationEmailInput): Promise<SendInvitationEmailResult>
}

/** The product's user table, narrowed to the columns the queries read. */
export interface InvitationUserTable {
  id: any
  email: any
  emailVerified: any
}

/** The product's workspace table, narrowed to the columns the queries read. */
export interface InvitationWorkspaceTable {
  id: any
  name: any
}

/** Define configuration options required to manage workspace invitations and related data sources */
export interface InvitationsApiOptions {
  db: TeamDatabase
  tables: TeamTables
  /** The invitation table from `createWorkspaceInvitationTable`. */
  invitationsTable: WorkspaceInvitationTables
  userTable: TeamParentTable & InvitationUserTable
  workspaceTable: TeamParentTable & InvitationWorkspaceTable
  access: Pick<WorkspaceAccessApi, 'getWorkspaceAccess'>
  /** REQUIRED — the app's mail transport (e.g. Resend + renderInvitationEmail). */
  sendInvitationEmail: SendInvitationEmailSeam
  /** OPTIONAL — seat-limit gate at create time; mirrors members-api. */
  enforceSeat?: EnforceSeatSeam
  /** OPTIONAL — fire-and-forget member propagation on accept. */
  memberSyncSeam?: Pick<MemberSyncSeam, 'add'>
  /** Inviter display fallback when the inviter's email is unknown. */
  productDisplayName?: string
}

/** Represent a workspace invitation with details about inviter, permissions, status, and timestamps */
export interface WorkspaceInvitationView {
  id: string
  workspaceId: string
  organizationId: string
  email: string
  invitedByUserId: string
  inviterEmail: string | null
  permissions: InvitationPermission
  token: string
  status: InvitationStatus
  emailStatus: InvitationEmailStatus
  expiresAt: Date
  createdAt: Date
  acceptedAt: Date | null
  revokedAt: Date | null
  lastSentAt: Date | null
}

/** Describe the structure of an invitation preview with workspace, email, permissions, status, and expiration details */
export interface InvitationPreview {
  workspaceId: string
  workspaceName: string
  email: string
  inviterEmail: string | null
  permissions: InvitationPermission
  status: InvitationStatus
  expiresAt: Date
}

/** Resolve the result of an invitation as success with a value or failure with status and error details */
export type InvitationOutcome<T> =
  | { succeeded: true; value: T }
  | { succeeded: false; status: number; error: string }

/**
 * Build the invitations API bound to one product's db/tables/access/seams.
 * Returns the six lifecycle handlers an app mounts in its routes.
 */
export function createInvitationsApi(opts: InvitationsApiOptions) {
  const { db, tables, access, sendInvitationEmail, enforceSeat, memberSyncSeam } = opts
  const { organizationMembers, workspaceMembers } = tables
  const { workspaceInvitations } = opts.invitationsTable
  const users = opts.userTable
  const workspaces = opts.workspaceTable
  const productDisplayName = opts.productDisplayName ?? 'A workspace admin'

  function fireSync(op: () => Promise<void> | void) {
    try {
      Promise.resolve(op()).catch(() => {})
    } catch {
      // seam threw synchronously — swallow; sync is best-effort by contract.
    }
  }

  async function createInvitation(input: {
    workspaceId: string
    email: string
    permissions: string | undefined
    invitedByUserId: string
    origin: string
    now?: Date
  }): Promise<InvitationOutcome<{ invitation: WorkspaceInvitationView; inviteUrl: string; emailError?: string }>> {
    const now = input.now ?? new Date()
    const accessRow = await access.getWorkspaceAccess(input.workspaceId, input.invitedByUserId, 'admin')
    if (!accessRow) return { succeeded: false, status: 404, error: 'Workspace not found' }

    const permissions = parseInvitationPermission(input.permissions ?? 'editor')
    if (!permissions) return { succeeded: false, status: 400, error: 'Invalid permissions' }
    if (!hasWorkspaceRole(accessRow.role, permissions)) {
      return { succeeded: false, status: 403, error: 'Cannot assign higher permissions than your own' }
    }

    const email = normalizeInvitationEmail(input.email)
    if (!email) return { succeeded: false, status: 400, error: 'Missing email' }

    const organizationId = accessRow.organization.id
    const workspaceName = (accessRow.workspace as { name: string }).name

    await expirePendingInvitations(input.workspaceId, email, now)

    const existingPending = await getPendingInvitation(input.workspaceId, email)
    if (existingPending) return { succeeded: false, status: 409, error: 'A pending invitation already exists for this email' }

    const accountCheck = await checkExistingAccountAccess(organizationId, input.workspaceId, email, input.invitedByUserId)
    if (!accountCheck.succeeded) return accountCheck

    // Seat gate: only a genuinely NEW seat. The checks above reject re-invites,
    // existing workspace members, and org admins; an existing plain org member is
    // already billable (no new seat), so skip the gate for them — mirrors
    // members-api. The pending row is not inserted yet, so the seam's count
    // reflects current usage and denies the invite that would push OVER the limit
    // (at invite time, not accept time).
    if (enforceSeat && !accountCheck.isExistingOrgMember) {
      try {
        await enforceSeat({ actorId: input.invitedByUserId, organizationId })
      } catch (err) {
        if (err instanceof SeatLimitError) return { succeeded: false, status: err.status, error: err.message }
        throw err
      }
    }

    const token = generateInvitationToken()
    const expiresAt = getInvitationExpiresAt(now)

    const [created] = await db.insert(workspaceInvitations).values({
      workspaceId: input.workspaceId,
      organizationId,
      email,
      invitedByUserId: input.invitedByUserId,
      permissions,
      token,
      status: 'pending',
      emailStatus: 'not_sent',
      expiresAt,
      createdAt: now,
    }).returning()

    const inviteUrl = inviteUrlForToken(input.origin, token)
    const emailResult = await sendInvitationEmail({
      to: email,
      workspaceName,
      inviterEmail: accountCheck.inviterEmail ?? productDisplayName,
      permission: permissions,
      inviteUrl,
      expiresAt,
    })

    const emailStatus: InvitationEmailStatus = emailResult.succeeded ? 'sent' : 'failed'
    const [updated] = await db.update(workspaceInvitations)
      .set({ emailStatus, lastSentAt: emailResult.succeeded ? now : null })
      .where(eq(workspaceInvitations.id, created!.id))
      .returning()

    return {
      succeeded: true,
      value: {
        invitation: toInvitationView(updated!, accountCheck.inviterEmail),
        inviteUrl,
        emailError: emailResult.succeeded ? undefined : emailResult.error,
      },
    }
  }

  async function listInvitations(input: {
    workspaceId: string
    userId: string
    origin: string
    now?: Date
  }): Promise<InvitationOutcome<{ invitations: Array<WorkspaceInvitationView & { inviteUrl: string }> }>> {
    const accessRow = await access.getWorkspaceAccess(input.workspaceId, input.userId, 'admin')
    if (!accessRow) return { succeeded: false, status: 404, error: 'Workspace not found' }

    await expirePendingInvitations(input.workspaceId, undefined, input.now ?? new Date())

    const rows = await db
      .select({ invitation: workspaceInvitations, inviterEmail: users.email })
      .from(workspaceInvitations)
      .leftJoin(users, eq(users.id, workspaceInvitations.invitedByUserId))
      .where(eq(workspaceInvitations.workspaceId, input.workspaceId))
      .orderBy(sql`${workspaceInvitations.createdAt} desc`)

    return {
      succeeded: true,
      value: {
        invitations: rows.map((row: { invitation: WorkspaceInvitationRow; inviterEmail: string | null }) => ({
          ...toInvitationView(row.invitation, row.inviterEmail),
          inviteUrl: inviteUrlForToken(input.origin, row.invitation.token),
        })),
      },
    }
  }

  async function resendInvitation(input: {
    invitationId: string
    userId: string
    origin: string
    now?: Date
  }): Promise<InvitationOutcome<{ invitation: WorkspaceInvitationView; inviteUrl: string; emailError?: string }>> {
    const row = await getInvitationById(input.invitationId)
    if (!row) return { succeeded: false, status: 404, error: 'Invitation not found' }

    const accessRow = await access.getWorkspaceAccess(row.invitation.workspaceId, input.userId, 'admin')
    if (!accessRow) return { succeeded: false, status: 404, error: 'Workspace not found' }

    const now = input.now ?? new Date()
    if (row.invitation.status !== 'pending') {
      return { succeeded: false, status: 409, error: 'Only pending invitations can be resent' }
    }
    if (row.invitation.expiresAt <= now) {
      await markInvitationExpired(row.invitation.id)
      return { succeeded: false, status: 409, error: 'Invitation has expired' }
    }

    const workspaceName = (accessRow.workspace as { name: string }).name
    const inviteUrl = inviteUrlForToken(input.origin, row.invitation.token)
    const emailResult = await sendInvitationEmail({
      to: row.invitation.email,
      workspaceName,
      inviterEmail: row.inviterEmail ?? productDisplayName,
      permission: row.invitation.permissions,
      inviteUrl,
      expiresAt: row.invitation.expiresAt,
    })

    const [updated] = await db.update(workspaceInvitations)
      .set({
        emailStatus: emailResult.succeeded ? 'sent' : 'failed',
        lastSentAt: emailResult.succeeded ? now : row.invitation.lastSentAt,
      })
      .where(eq(workspaceInvitations.id, row.invitation.id))
      .returning()

    return {
      succeeded: true,
      value: {
        invitation: toInvitationView(updated!, row.inviterEmail),
        inviteUrl,
        emailError: emailResult.succeeded ? undefined : emailResult.error,
      },
    }
  }

  async function revokeInvitation(input: {
    invitationId: string
    userId: string
    now?: Date
  }): Promise<InvitationOutcome<{ invitation: WorkspaceInvitationView }>> {
    const row = await getInvitationById(input.invitationId)
    if (!row) return { succeeded: false, status: 404, error: 'Invitation not found' }

    const accessRow = await access.getWorkspaceAccess(row.invitation.workspaceId, input.userId, 'admin')
    if (!accessRow) return { succeeded: false, status: 404, error: 'Workspace not found' }
    if (row.invitation.status !== 'pending') {
      return { succeeded: false, status: 409, error: 'Only pending invitations can be revoked' }
    }

    const [updated] = await db.update(workspaceInvitations)
      .set({ status: 'revoked', revokedAt: input.now ?? new Date() })
      .where(eq(workspaceInvitations.id, row.invitation.id))
      .returning()

    return { succeeded: true, value: { invitation: toInvitationView(updated!, row.inviterEmail) } }
  }

  async function getPreview(token: string, now: Date = new Date()): Promise<InvitationOutcome<InvitationPreview>> {
    const row = await getInvitationByToken(token)
    if (!row) return { succeeded: false, status: 404, error: 'Invitation not found' }

    let invitation = row.invitation
    if (invitation.status === 'pending' && invitation.expiresAt <= now) {
      invitation = await markInvitationExpired(invitation.id)
    }

    return {
      succeeded: true,
      value: {
        workspaceId: invitation.workspaceId,
        workspaceName: row.workspaceName,
        email: invitation.email,
        inviterEmail: row.inviterEmail,
        permissions: invitation.permissions,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
      },
    }
  }

  async function acceptInvitation(input: {
    token: string
    userId: string
    now?: Date
  }): Promise<InvitationOutcome<{ workspaceId: string }>> {
    const now = input.now ?? new Date()
    const row = await getInvitationByToken(input.token)
    if (!row) return { succeeded: false, status: 404, error: 'Invitation not found' }

    let invitation = row.invitation
    if (invitation.status === 'pending' && invitation.expiresAt <= now) {
      invitation = await markInvitationExpired(invitation.id)
    }

    const [currentUser] = await db
      .select({ id: users.id, email: users.email, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
    if (!currentUser) return { succeeded: false, status: 401, error: 'Authentication required' }

    if (normalizeInvitationEmail(currentUser.email) !== invitation.email) {
      return { succeeded: false, status: 403, error: 'Sign in with the invited email address to accept this invitation' }
    }

    const collisionCheck = await findUsersByNormalizedEmail(invitation.email)
    if (collisionCheck.length > 1) {
      return {
        succeeded: false,
        status: 409,
        error: 'Multiple accounts use this email. Contact support to reconcile before accepting this invitation.',
      }
    }

    let orgMember = await getOrganizationMember(invitation.organizationId, currentUser.id)
    if (orgMember?.role === 'owner' || orgMember?.role === 'admin') {
      return { succeeded: false, status: 409, error: 'This user already has account-level access.' }
    }

    if (invitation.status === 'accepted') {
      const existing = orgMember ? await getWorkspaceMemberByOrganizationMember(invitation.workspaceId, orgMember.id) : null
      if (existing) return { succeeded: true, value: { workspaceId: invitation.workspaceId } }
      return { succeeded: false, status: 409, error: 'Invitation has already been accepted' }
    }
    if (invitation.status === 'expired') return { succeeded: false, status: 409, error: 'Invitation has expired' }
    if (invitation.status === 'revoked') return { succeeded: false, status: 409, error: 'Invitation has been revoked' }

    if (!orgMember) {
      const [inserted] = await db.insert(organizationMembers).values({
        organizationId: invitation.organizationId,
        userId: currentUser.id,
        role: 'member',
        createdAt: now,
        updatedAt: now,
      }).returning()
      if (!inserted) return { succeeded: false, status: 500, error: 'Failed to create organization membership' }
      orgMember = inserted
    }

    const existingMember = await getWorkspaceMemberByOrganizationMember(invitation.workspaceId, orgMember.id)
    if (!existingMember) {
      await db.insert(workspaceMembers).values({
        workspaceId: invitation.workspaceId,
        organizationMemberId: orgMember.id,
        userId: currentUser.id,
        role: invitation.permissions,
        inviteEmail: invitation.email,
        // members-api nulls the token on accept to release the unique slot; the
        // invitations flow keeps it (its `inv_` tokens never collide), so the
        // materialized row carries the originating token for audit.
        inviteToken: invitation.token,
        invitedAt: now,
        acceptedAt: now,
      })
      if (memberSyncSeam?.add) {
        const userId = currentUser.id
        const role = invitation.permissions as WorkspaceRole
        fireSync(() => memberSyncSeam.add!({ workspaceId: invitation.workspaceId, userId, role }))
      }
    }

    await db.update(workspaceInvitations)
      .set({ status: 'accepted', acceptedAt: now })
      .where(eq(workspaceInvitations.id, invitation.id))

    return { succeeded: true, value: { workspaceId: invitation.workspaceId } }
  }

  // ── internal query helpers ──

  async function expirePendingInvitations(workspaceId: string, email: string | undefined, now: Date) {
    const conditions = [
      eq(workspaceInvitations.workspaceId, workspaceId),
      eq(workspaceInvitations.status, 'pending' as const),
      lte(workspaceInvitations.expiresAt, now),
    ]
    if (email) conditions.push(eq(workspaceInvitations.email, email))
    await db.update(workspaceInvitations).set({ status: 'expired' }).where(and(...conditions))
  }

  async function getPendingInvitation(workspaceId: string, email: string) {
    const [invitation] = await db
      .select({ id: workspaceInvitations.id })
      .from(workspaceInvitations)
      .where(and(
        eq(workspaceInvitations.workspaceId, workspaceId),
        eq(workspaceInvitations.email, email),
        eq(workspaceInvitations.status, 'pending' as const),
      ))
      .limit(1)
    return invitation ?? null
  }

  async function checkExistingAccountAccess(
    organizationId: string,
    workspaceId: string,
    email: string,
    invitedByUserId: string,
  ): Promise<
    | { succeeded: false; status: number; error: string }
    | { succeeded: true; inviterEmail: string | null; isExistingOrgMember: boolean }
  > {
    const matchingUsers = await findUsersByNormalizedEmail(email)
    const [inviter] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, invitedByUserId))
      .limit(1)

    if (matchingUsers.length > 1) {
      return {
        succeeded: false,
        status: 409,
        error: 'Multiple accounts use this email. Contact support to reconcile before inviting this user.',
      }
    }
    const existingUser = matchingUsers[0]
    if (!existingUser) return { succeeded: true, inviterEmail: inviter?.email ?? null, isExistingOrgMember: false }

    const orgMember = await getOrganizationMember(organizationId, existingUser.id)
    if (orgMember?.role === 'owner' || orgMember?.role === 'admin') {
      return { succeeded: false, status: 409, error: 'This user already has account-level access.' }
    }
    if (orgMember) {
      const workspaceMember = await getWorkspaceMemberByOrganizationMember(workspaceId, orgMember.id)
      if (workspaceMember) return { succeeded: false, status: 409, error: 'User is already a workspace member' }
    }

    return { succeeded: true, inviterEmail: inviter?.email ?? null, isExistingOrgMember: Boolean(orgMember) }
  }

  async function findUsersByNormalizedEmail(email: string) {
    return db
      .select({ id: users.id, email: users.email, emailVerified: users.emailVerified })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
  }

  async function getOrganizationMember(organizationId: string, userId: string) {
    const [member] = await db
      .select()
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
      .limit(1)
    return member ?? null
  }

  async function getWorkspaceMemberByOrganizationMember(workspaceId: string, organizationMemberId: string) {
    const [member] = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.organizationMemberId, organizationMemberId),
      ))
      .limit(1)
    return member ?? null
  }

  async function getInvitationById(invitationId: string) {
    const [row] = await db
      .select({ invitation: workspaceInvitations, inviterEmail: users.email })
      .from(workspaceInvitations)
      .leftJoin(users, eq(users.id, workspaceInvitations.invitedByUserId))
      .where(eq(workspaceInvitations.id, invitationId))
      .limit(1)
    return row ?? null
  }

  async function getInvitationByToken(token: string) {
    const [row] = await db
      .select({
        invitation: workspaceInvitations,
        workspaceName: workspaces.name,
        inviterEmail: users.email,
      })
      .from(workspaceInvitations)
      .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
      .leftJoin(users, eq(users.id, workspaceInvitations.invitedByUserId))
      .where(eq(workspaceInvitations.token, token))
      .limit(1)
    return row ?? null
  }

  async function markInvitationExpired(invitationId: string) {
    const [updated] = await db.update(workspaceInvitations)
      .set({ status: 'expired' })
      .where(eq(workspaceInvitations.id, invitationId))
      .returning()
    return updated!
  }

  function toInvitationView(invitation: WorkspaceInvitationRow, inviterEmail: string | null): WorkspaceInvitationView {
    return {
      id: invitation.id,
      workspaceId: invitation.workspaceId,
      organizationId: invitation.organizationId,
      email: invitation.email,
      invitedByUserId: invitation.invitedByUserId,
      inviterEmail,
      permissions: invitation.permissions,
      token: invitation.token,
      status: invitation.status,
      emailStatus: invitation.emailStatus,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
      acceptedAt: invitation.acceptedAt,
      revokedAt: invitation.revokedAt,
      lastSentAt: invitation.lastSentAt,
    }
  }

  return { createInvitation, listInvitations, resendInvitation, revokeInvitation, getPreview, acceptInvitation }
}
