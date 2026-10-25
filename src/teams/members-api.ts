/**
 * Framework-neutral members API for the teams module: the invite / list /
 * update-role / remove / accept-invite logic, lifted out of any one app's route
 * file. Each app mounts these in its own route with its own auth — the handlers
 * take an already-authenticated `actor`, the parsed inputs, the `db` + `tables`
 * from `createTeamTables`, the product's user + workspace tables, and the
 * workspace-access API from `createWorkspaceAccess`. They return web-standard
 * `Response`s (available in Workers, Node 18+, Deno, browsers), so
 * "framework-neutral" is literal: no Remix/React-Router/Express import anywhere.
 *
 * Two OPTIONAL seams an app wires only if it needs them:
 *   - `enforceSeat` — billing/seat-limit gate, called at invite time only when
 *     the invite would consume a NEW billable seat. An app without seat billing
 *     passes nothing and seats are never checked.
 *   - `memberSyncSeam` — fire-and-forget propagation of membership changes to a
 *     sandbox/external system (add on accept, role on update, remove on
 *     delete). An app without sandbox sync passes nothing. Fail-soft by
 *     contract: a thrown sync is caught and never blocks the DB mutation.
 *
 * Imports `drizzle-orm`, so this is a subpath, never re-exported from root.
 */

import { fireMemberSync } from './member-sync'

import { and, eq, isNull } from 'drizzle-orm'
import { INVITATION_EMAIL_HINT, isInvitationEmail } from './invitations'
import {
  type AssignableWorkspaceRole,
  type WorkspaceRole,
  canManageWorkspaceMemberRole,
  hasWorkspaceRole,
  isAssignableWorkspaceRole,
  organizationRoleGrantsWorkspaceOwner,
} from './roles'
import { generateInviteToken, validateInviteToken } from './invite'
import type { TeamDatabase, WorkspaceAccessReader } from './drizzle/access'
import type { TeamParentTable, TeamTables } from './drizzle/schema'

/** The authenticated caller — apps resolve this from their own session layer. */
export interface MembersApiActor {
  id: string
  email?: string | null
}

/**
 * The product's user table, narrowed to the columns the member queries read.
 * Adopters pass their real drizzle user table.
 */
export interface UserLookupTable {
  id: any
  name: any
  email: any
}

/**
 * The product's workspace table, narrowed to the columns the member queries
 * read. The handlers join it to resolve a workspace's organization (the same
 * table passed to createTeamTables as workspaceTable).
 */
export interface WorkspaceLookupTable {
  id: any
  organizationId: any
  /** Display name, read by `getInviteDetails` when present. */
  name?: any
}

/**
 * Optional billing seat gate. The seam resolves the count input itself (it
 * owns the plan/seat model) and throws when over the limit; the handler turns a
 * thrown `SeatLimitError` into a 402. Called only when an invite would consume
 * a NEW seat (invitee is not already an org member and has no pending org
 * invite) — the same guard gtm uses, so the seam never fires on a no-op invite.
 */
export interface EnforceSeatSeam {
  (input: { actorId: string; organizationId: string }): Promise<void> | void
}

/** Thrown by an `enforceSeat` seam to deny an invite; serialized to a 402. */
export class SeatLimitError extends Error {
  readonly status: number
  readonly capability?: string
  readonly requiredPlan?: string
  constructor(message: string, opts: { status?: number; capability?: string; requiredPlan?: string } = {}) {
    super(message)
    this.name = 'SeatLimitError'
    this.status = opts.status ?? 402
    this.capability = opts.capability
    this.requiredPlan = opts.requiredPlan
  }
}

/**
 * Optional membership-change propagation to an external system (e.g. sandbox).
 * Every method is fire-and-forget and fail-soft: the handler awaits nothing and
 * swallows rejections, so an unavailable downstream never blocks the mutation.
 * Each fires only for members with a real `userId` (never email-only invites).
 */
export interface MemberSyncCallbacks {
  add?(input: { workspaceId: string; userId: string; role: WorkspaceRole }): Promise<void> | void
  role?(input: { workspaceId: string; userId: string; role: WorkspaceRole }): Promise<void> | void
  remove?(input: { workspaceId: string; userId: string }): Promise<void> | void
}

/** Define configuration options for managing team members and workspace access APIs */
export interface MembersApiOptions {
  db: TeamDatabase
  tables: TeamTables
  /** The product's user table (FK target passed to createTeamTables). */
  userTable: TeamParentTable & UserLookupTable
  /** The product's workspace table (FK target passed to createTeamTables). */
  workspaceTable: TeamParentTable & WorkspaceLookupTable
  /** Workspace-access API from createWorkspaceAccess — RBAC stays one source. */
  access: WorkspaceAccessReader
  enforceSeat?: EnforceSeatSeam
  memberSyncSeam?: MemberSyncCallbacks
}

/** Define the structure of a workspace member entry with identification, role, and status details */
export interface MemberListEntry {
  id: string
  userId: string | null
  organizationMemberId: string | null
  role: WorkspaceRole
  name: string | null
  email: string | null
  invitedAt: Date | number | null
  acceptedAt: Date | number | null
  inherited: boolean
}

/** A pending-member invite as the invite page shows it. */
export interface InviteDetails {
  status: 'pending' | 'invalid' | 'already-accepted'
  workspaceName: string | null
  inviterName: string | null
  role: WorkspaceRole | null
  inviteEmail: string | null
  currentUserEmail: string | null
}

/**
 * Build the members API bound to one product's db/tables/access. Returns the
 * handlers an app maps its route methods onto (GET→list, POST→invite,
 * PATCH→updateRole, DELETE→remove; accept on its own route), and
 * `handleMembersRequest`, which does that mapping for a single members route.
 */
export function createMembersApi(opts: MembersApiOptions) {
  const { db, tables, userTable, workspaceTable, access, enforceSeat, memberSyncSeam } = opts
  const { organizations, organizationMembers, workspaceMembers } = tables
  const users = userTable
  const workspaces = workspaceTable

  async function inviteMember(input: {
    workspaceId: string
    actor: MembersApiActor
    email?: string
    role?: string
  }): Promise<Response> {
    if (!input.email) return Response.json({ error: 'Missing email' }, { status: 400 })
    if (!isInvitationEmail(input.email)) return Response.json({ error: INVITATION_EMAIL_HINT }, { status: 400 })
    const requestedRole = input.role ?? 'editor'
    if (!isAssignableWorkspaceRole(requestedRole)) {
      return Response.json({ error: 'Invalid role. Must be viewer, editor, or admin.' }, { status: 400 })
    }
    const assignRole: AssignableWorkspaceRole = requestedRole
    const accessRow = await access.getWorkspaceAccess(input.workspaceId, input.actor.id, 'admin')
    if (!accessRow) return Response.json({ error: 'Workspace not found' }, { status: 404 })
    if (!hasWorkspaceRole(accessRow.role, assignRole)) {
      return Response.json({ error: 'Cannot assign a role higher than your own' }, { status: 403 })
    }

    const organizationId = (accessRow.workspace as { organizationId: string }).organizationId
    const normalizedEmail = input.email.toLowerCase().trim()
    const invitee = await getUserByEmail(normalizedEmail)
    const existingOrgMember = invitee ? await getOrganizationMember(organizationId, invitee.id) : null

    if (organizationRoleGrantsWorkspaceOwner(existingOrgMember?.role)) {
      return Response.json({ error: 'Organization admins already have project access' }, { status: 409 })
    }

    const existingInvite = await findExistingProjectInvite(input.workspaceId, normalizedEmail, invitee?.id)
    if (existingInvite) {
      return Response.json({ error: 'This collaborator is already invited to this project' }, { status: 409 })
    }

    if (enforceSeat && !existingOrgMember && !(await hasPendingOrgInvite(organizationId, normalizedEmail))) {
      try {
        await enforceSeat({ actorId: input.actor.id, organizationId })
      } catch (err) {
        if (err instanceof SeatLimitError) {
          return Response.json(
            { error: err.message, capability: err.capability, requiredPlan: err.requiredPlan },
            { status: err.status },
          )
        }
        throw err
      }
    }

    const token = generateInviteToken()
    const [member] = await db
      .insert(workspaceMembers)
      .values({
        workspaceId: input.workspaceId,
        organizationMemberId: existingOrgMember?.id ?? null,
        userId: invitee?.id ?? null,
        role: assignRole,
        invitedBy: input.actor.id,
        inviteEmail: normalizedEmail,
        inviteToken: token,
      })
      .returning()

    return Response.json({ member, inviteToken: token })
  }

  async function updateMemberRole(input: {
    workspaceId: string
    actor: MembersApiActor
    memberId?: string
    role?: string
  }): Promise<Response> {
    if (!input.memberId || !input.role) {
      return Response.json({ error: 'Missing memberId or role' }, { status: 400 })
    }
    if (input.memberId.startsWith('org:')) {
      return Response.json({ error: 'Organization owner/admin project access is managed at the organization level' }, { status: 403 })
    }
    if (!isAssignableWorkspaceRole(input.role)) {
      return Response.json({ error: 'Invalid role' }, { status: 400 })
    }

    const accessRow = await access.getWorkspaceAccess(input.workspaceId, input.actor.id, 'admin')
    if (!accessRow) return Response.json({ error: 'Workspace not found' }, { status: 404 })
    if (!hasWorkspaceRole(accessRow.role, input.role)) {
      return Response.json({ error: 'Cannot assign a role higher than your own' }, { status: 403 })
    }

    const [target] = await db
      .select({ id: workspaceMembers.id, role: workspaceMembers.role, userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.id, input.memberId), eq(workspaceMembers.workspaceId, input.workspaceId)))
      .limit(1)

    if (!target) return Response.json({ error: 'Member not found' }, { status: 404 })
    if (target.userId === input.actor.id) return Response.json({ error: 'Cannot change your own role' }, { status: 403 })
    if (!canManageWorkspaceMemberRole(accessRow.role, target.role as WorkspaceRole)) {
      return Response.json({ error: 'Cannot modify a member with equal or higher role' }, { status: 403 })
    }

    await db.update(workspaceMembers).set({ role: input.role }).where(eq(workspaceMembers.id, input.memberId))
    if (target.userId && memberSyncSeam?.role) {
      const userId = target.userId
      const nextRole = input.role as WorkspaceRole
      fireMemberSync(() => memberSyncSeam.role!({ workspaceId: input.workspaceId, userId, role: nextRole }))
    }
    return Response.json({ success: true })
  }

  async function removeMember(input: {
    workspaceId: string
    actor: MembersApiActor
    memberId?: string
  }): Promise<Response> {
    if (!input.memberId) return Response.json({ error: 'Missing memberId' }, { status: 400 })
    if (input.memberId.startsWith('org:')) {
      return Response.json({ error: 'Organization owner/admin project access is managed at the organization level' }, { status: 403 })
    }

    const accessRow = await access.getWorkspaceAccess(input.workspaceId, input.actor.id, 'admin')
    if (!accessRow) return Response.json({ error: 'Workspace not found' }, { status: 404 })

    const [target] = await db
      .select({ id: workspaceMembers.id, role: workspaceMembers.role, userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.id, input.memberId), eq(workspaceMembers.workspaceId, input.workspaceId)))
      .limit(1)

    if (!target) return Response.json({ error: 'Member not found' }, { status: 404 })
    if (target.userId === input.actor.id) return Response.json({ error: 'Cannot remove yourself from this project' }, { status: 403 })
    if (!canManageWorkspaceMemberRole(accessRow.role, target.role as WorkspaceRole)) {
      return Response.json({ error: 'Cannot remove a member with equal or higher role' }, { status: 403 })
    }

    await db.delete(workspaceMembers).where(eq(workspaceMembers.id, input.memberId))
    if (target.userId && memberSyncSeam?.remove) {
      const userId = target.userId
      fireMemberSync(() => memberSyncSeam.remove!({ workspaceId: input.workspaceId, userId }))
    }
    return Response.json({ success: true })
  }

  /**
   * What the `/invite/:token` page shows before acceptance: the invite's
   * workspace, inviter, role and addressee, judged against the signed-in
   * email. Shaped for `InviteAcceptPage`'s `details`.
   */
  async function getInviteDetails(input: { token: string; currentUserEmail: string | null }): Promise<InviteDetails> {
    const { currentUserEmail } = input
    const none = { workspaceName: null, inviterName: null, role: null, inviteEmail: null, currentUserEmail }
    const [invite] = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.inviteToken, input.token))
      .limit(1)
    if (!invite) return { status: 'invalid', ...none }

    const validation = validateInviteToken(invite, { acceptingEmail: currentUserEmail })
    if (!validation.ok && validation.reason === 'already-accepted') return { status: 'already-accepted', ...none }

    const [workspace] = workspaces.name === undefined
      ? []
      : await db
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, invite.workspaceId))
        .limit(1)
    const [inviter] = invite.invitedBy
      ? await db.select({ name: users.name }).from(users).where(eq(users.id, invite.invitedBy)).limit(1)
      : []

    return {
      status: 'pending',
      workspaceName: (workspace as { name?: string | null } | undefined)?.name ?? null,
      inviterName: (inviter as { name?: string | null } | undefined)?.name ?? null,
      role: invite.role as WorkspaceRole,
      inviteEmail: invite.inviteEmail ?? null,
      currentUserEmail,
    }
  }

  async function acceptInvite(input: { token?: string; actor: MembersApiActor }): Promise<Response> {
    if (!input.token || typeof input.token !== 'string') {
      return Response.json({ error: 'Missing invite token' }, { status: 400 })
    }

    const [invite] = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.inviteToken, input.token))
      .limit(1)

    if (!invite) return Response.json({ error: 'Invalid or expired invite' }, { status: 404 })
    if (invite.acceptedAt) return Response.json({ error: 'Invite already accepted' }, { status: 409 })

    if (invite.inviteEmail && invite.inviteEmail.toLowerCase() !== input.actor.email?.toLowerCase()) {
      return Response.json(
        { error: `This invite was sent to ${invite.inviteEmail}. Please sign in with that email.` },
        { status: 403 },
      )
    }

    const [workspace] = await db
      .select({ id: workspaces.id, organizationId: workspaces.organizationId })
      .from(workspaces)
      .where(eq(workspaces.id, invite.workspaceId))
      .limit(1)

    if (!workspace) return Response.json({ error: 'Project not found' }, { status: 404 })
    const organizationId = (workspace as { organizationId: string }).organizationId

    // Atomic accept: only succeeds if the token still exists and is unaccepted,
    // so two concurrent accepts can't both win.
    const updated = await db
      .update(workspaceMembers)
      .set({
        userId: input.actor.id,
        acceptedAt: new Date(),
        inviteToken: null,
      })
      .where(and(
        eq(workspaceMembers.inviteToken, input.token),
        isNull(workspaceMembers.acceptedAt),
      ))
      .returning({ id: workspaceMembers.id })

    if (updated.length === 0) return Response.json({ error: 'Invite already accepted' }, { status: 409 })

    const [orgMember] = await db
      .insert(organizationMembers)
      .values({
        organizationId,
        userId: input.actor.id,
        role: 'member',
      })
      .onConflictDoUpdate({
        target: [organizationMembers.organizationId, organizationMembers.userId],
        set: { updatedAt: new Date() },
      })
      .returning()

    await db
      .update(workspaceMembers)
      .set({ organizationMemberId: invite.organizationMemberId ?? orgMember!.id })
      .where(eq(workspaceMembers.id, updated[0]!.id))

    if (memberSyncSeam?.add) {
      const role = invite.role as WorkspaceRole
      fireMemberSync(() => memberSyncSeam.add!({ workspaceId: invite.workspaceId, userId: input.actor.id, role }))
    }

    return Response.json({
      success: true,
      workspaceId: invite.workspaceId,
      role: invite.role,
    })
  }

  const { listMembers, getUserByEmail, getOrganizationMember, findExistingProjectInvite, hasPendingOrgInvite } = createMemberQueries(db, users, organizationMembers, workspaceMembers, workspaces, access)

  /**
   * The members route: GET lists, POST invites, PATCH changes a role, DELETE
   * removes, each against `workspaceId` (query for GET, JSON body otherwise).
   * `actor` is the authenticated caller, or null for a 401.
   */
  async function handleMembersRequest(request: Request, actor: MembersApiActor | null): Promise<Response> {
    if (!actor) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    if (request.method === 'GET' || request.method === 'HEAD') {
      const workspaceId = new URL(request.url).searchParams.get('workspaceId')
      if (!workspaceId) return Response.json({ error: 'Missing workspaceId' }, { status: 400 })
      return listMembers({ workspaceId, actor })
    }

    const raw = await request.json().catch(() => null)
    if (!raw || typeof raw !== 'object') return Response.json({ error: 'Invalid body' }, { status: 400 })
    const body = raw as Record<string, unknown>
    const str = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : undefined)

    const workspaceId = str('workspaceId')
    if (!workspaceId) return Response.json({ error: 'Missing workspaceId' }, { status: 400 })

    if (request.method === 'POST') {
      return inviteMember({ workspaceId, actor, email: str('email'), role: str('role') })
    }
    if (request.method === 'PATCH') {
      return updateMemberRole({ workspaceId, actor, memberId: str('memberId'), role: str('role') })
    }
    if (request.method === 'DELETE') {
      return removeMember({ workspaceId, actor, memberId: str('memberId') })
    }
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  return { listMembers, inviteMember, updateMemberRole, removeMember, getInviteDetails, acceptInvite, handleMembersRequest }
}

function createMemberQueries(
  db: MembersApiOptions['db'],
  users: MembersApiOptions['userTable'],
  organizationMembers: MembersApiOptions['tables']['organizationMembers'],
  workspaceMembers: MembersApiOptions['tables']['workspaceMembers'],
  workspaces: MembersApiOptions['workspaceTable'],
  access: MembersApiOptions['access'],
) {
  // ── internal query helpers ──

  async function getUserByEmail(email: string) {
    const [user] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, email))
      .limit(1)
    return user ?? null
  }

  async function getOrganizationMember(organizationId: string, userId: string) {
    const [member] = await db
      .select()
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
      .limit(1)
    return member ?? null
  }

  async function findExistingProjectInvite(workspaceId: string, email: string, userId?: string) {
    const byEmail = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.inviteEmail, email)))
      .limit(1)
    if (byEmail[0]) return byEmail[0]
    if (!userId) return null
    const byUser = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .limit(1)
    return byUser[0] ?? null
  }

  async function hasPendingOrgInvite(organizationId: string, email: string): Promise<boolean> {
    const [row] = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(
        eq(workspaces.organizationId, organizationId),
        eq(workspaceMembers.inviteEmail, email),
        isNull(workspaceMembers.acceptedAt),
      ))
      .limit(1)
    return Boolean(row)
  }




  async function listMembers(input: { workspaceId: string; actor: MembersApiActor }): Promise<Response> {
    const accessRow = await access.getWorkspaceAccess(input.workspaceId, input.actor.id)
    if (!accessRow) return Response.json({ error: 'Workspace not found' }, { status: 404 })

    const organizationId = (accessRow.workspace as { organizationId: string }).organizationId

    const [projectMembers, orgAdmins] = await Promise.all([
      db
        .select({
          id: workspaceMembers.id,
          organizationMemberId: workspaceMembers.organizationMemberId,
          userId: workspaceMembers.userId,
          role: workspaceMembers.role,
          invitedAt: workspaceMembers.invitedAt,
          acceptedAt: workspaceMembers.acceptedAt,
          inviteEmail: workspaceMembers.inviteEmail,
          userName: users.name,
          userEmail: users.email,
        })
        .from(workspaceMembers)
        .leftJoin(users, eq(users.id, workspaceMembers.userId))
        .where(eq(workspaceMembers.workspaceId, input.workspaceId)),
      db
        .select({
          id: organizationMembers.id,
          userId: organizationMembers.userId,
          orgRole: organizationMembers.role,
          userName: users.name,
          userEmail: users.email,
          createdAt: organizationMembers.createdAt,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(eq(organizationMembers.organizationId, organizationId)),
    ])

    const explicitOrgMemberIds = new Set(
      projectMembers.map((m: any) => m.organizationMemberId).filter(Boolean),
    )
    const members: MemberListEntry[] = [
      ...orgAdmins
        .filter((m: any) => organizationRoleGrantsWorkspaceOwner(m.orgRole) && !explicitOrgMemberIds.has(m.id))
        .map((m: any) => ({
          id: `org:${m.id}`,
          userId: m.userId,
          organizationMemberId: m.id,
          role: 'owner' as WorkspaceRole,
          name: m.userName,
          email: m.userEmail,
          invitedAt: m.createdAt,
          acceptedAt: m.createdAt,
          inherited: true,
        })),
      ...projectMembers.map((m: any) => ({
        id: m.id,
        userId: m.userId,
        organizationMemberId: m.organizationMemberId,
        role: m.role as WorkspaceRole,
        name: m.userName,
        email: m.userEmail ?? m.inviteEmail,
        invitedAt: m.invitedAt,
        acceptedAt: m.acceptedAt,
        inherited: false,
      })),
    ]

    return Response.json({ members, currentRole: accessRow.role, organizationId })
  }

  return { listMembers, getUserByEmail, getOrganizationMember, findExistingProjectInvite, hasPendingOrgInvite }
}
