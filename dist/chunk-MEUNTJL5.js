import {
  generateInviteToken
} from "./chunk-DJ4VJIH5.js";
import {
  canManageWorkspaceMemberRole,
  hasWorkspaceRole,
  isAssignableWorkspaceRole,
  organizationRoleGrantsWorkspaceOwner
} from "./chunk-6XIAPIW6.js";

// src/teams/members-api.ts
import { and, eq, isNull } from "drizzle-orm";
var SeatLimitError = class extends Error {
  status;
  capability;
  requiredPlan;
  constructor(message, opts = {}) {
    super(message);
    this.name = "SeatLimitError";
    this.status = opts.status ?? 402;
    this.capability = opts.capability;
    this.requiredPlan = opts.requiredPlan;
  }
};
function createMembersApi(opts) {
  const { db, tables, userTable, workspaceTable, access, enforceSeat, memberSyncSeam } = opts;
  const { organizations, organizationMembers, workspaceMembers } = tables;
  const users = userTable;
  const workspaces = workspaceTable;
  function fireSync(op) {
    try {
      Promise.resolve(op()).catch(() => {
      });
    } catch {
    }
  }
  async function listMembers(input) {
    const accessRow = await access.getWorkspaceAccess(input.workspaceId, input.actor.id);
    if (!accessRow) return Response.json({ error: "Workspace not found" }, { status: 404 });
    const organizationId = accessRow.workspace.organizationId;
    const [projectMembers, orgAdmins] = await Promise.all([
      db.select({
        id: workspaceMembers.id,
        organizationMemberId: workspaceMembers.organizationMemberId,
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        invitedAt: workspaceMembers.invitedAt,
        acceptedAt: workspaceMembers.acceptedAt,
        inviteEmail: workspaceMembers.inviteEmail,
        userName: users.name,
        userEmail: users.email
      }).from(workspaceMembers).leftJoin(users, eq(users.id, workspaceMembers.userId)).where(eq(workspaceMembers.workspaceId, input.workspaceId)),
      db.select({
        id: organizationMembers.id,
        userId: organizationMembers.userId,
        orgRole: organizationMembers.role,
        userName: users.name,
        userEmail: users.email,
        createdAt: organizationMembers.createdAt
      }).from(organizationMembers).innerJoin(users, eq(users.id, organizationMembers.userId)).where(eq(organizationMembers.organizationId, organizationId))
    ]);
    const explicitOrgMemberIds = new Set(
      projectMembers.map((m) => m.organizationMemberId).filter(Boolean)
    );
    const members = [
      ...orgAdmins.filter((m) => organizationRoleGrantsWorkspaceOwner(m.orgRole) && !explicitOrgMemberIds.has(m.id)).map((m) => ({
        id: `org:${m.id}`,
        userId: m.userId,
        organizationMemberId: m.id,
        role: "owner",
        name: m.userName,
        email: m.userEmail,
        invitedAt: m.createdAt,
        acceptedAt: m.createdAt,
        inherited: true
      })),
      ...projectMembers.map((m) => ({
        id: m.id,
        userId: m.userId,
        organizationMemberId: m.organizationMemberId,
        role: m.role,
        name: m.userName,
        email: m.userEmail ?? m.inviteEmail,
        invitedAt: m.invitedAt,
        acceptedAt: m.acceptedAt,
        inherited: false
      }))
    ];
    return Response.json({ members, currentRole: accessRow.role, organizationId });
  }
  async function inviteMember(input) {
    if (!input.email) return Response.json({ error: "Missing email" }, { status: 400 });
    const requestedRole = input.role ?? "editor";
    if (!isAssignableWorkspaceRole(requestedRole)) {
      return Response.json({ error: "Invalid role. Must be viewer, editor, or admin." }, { status: 400 });
    }
    const assignRole = requestedRole;
    const accessRow = await access.getWorkspaceAccess(input.workspaceId, input.actor.id, "admin");
    if (!accessRow) return Response.json({ error: "Workspace not found" }, { status: 404 });
    if (!hasWorkspaceRole(accessRow.role, assignRole)) {
      return Response.json({ error: "Cannot assign a role higher than your own" }, { status: 403 });
    }
    const organizationId = accessRow.workspace.organizationId;
    const normalizedEmail = input.email.toLowerCase().trim();
    const invitee = await getUserByEmail(normalizedEmail);
    const existingOrgMember = invitee ? await getOrganizationMember(organizationId, invitee.id) : null;
    if (organizationRoleGrantsWorkspaceOwner(existingOrgMember?.role)) {
      return Response.json({ error: "Organization admins already have project access" }, { status: 409 });
    }
    const existingInvite = await findExistingProjectInvite(input.workspaceId, normalizedEmail, invitee?.id);
    if (existingInvite) {
      return Response.json({ error: "This collaborator is already invited to this project" }, { status: 409 });
    }
    if (enforceSeat && !existingOrgMember && !await hasPendingOrgInvite(organizationId, normalizedEmail)) {
      try {
        await enforceSeat({ actorId: input.actor.id, organizationId });
      } catch (err) {
        if (err instanceof SeatLimitError) {
          return Response.json(
            { error: err.message, capability: err.capability, requiredPlan: err.requiredPlan },
            { status: err.status }
          );
        }
        throw err;
      }
    }
    const token = generateInviteToken();
    const [member] = await db.insert(workspaceMembers).values({
      workspaceId: input.workspaceId,
      organizationMemberId: existingOrgMember?.id ?? null,
      userId: invitee?.id ?? null,
      role: assignRole,
      invitedBy: input.actor.id,
      inviteEmail: normalizedEmail,
      inviteToken: token
    }).returning();
    return Response.json({ member, inviteToken: token });
  }
  async function updateMemberRole(input) {
    if (!input.memberId || !input.role) {
      return Response.json({ error: "Missing memberId or role" }, { status: 400 });
    }
    if (input.memberId.startsWith("org:")) {
      return Response.json({ error: "Organization owner/admin project access is managed at the organization level" }, { status: 403 });
    }
    if (!isAssignableWorkspaceRole(input.role)) {
      return Response.json({ error: "Invalid role" }, { status: 400 });
    }
    const accessRow = await access.getWorkspaceAccess(input.workspaceId, input.actor.id, "admin");
    if (!accessRow) return Response.json({ error: "Workspace not found" }, { status: 404 });
    if (!hasWorkspaceRole(accessRow.role, input.role)) {
      return Response.json({ error: "Cannot assign a role higher than your own" }, { status: 403 });
    }
    const [target] = await db.select({ id: workspaceMembers.id, role: workspaceMembers.role, userId: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.id, input.memberId), eq(workspaceMembers.workspaceId, input.workspaceId))).limit(1);
    if (!target) return Response.json({ error: "Member not found" }, { status: 404 });
    if (target.userId === input.actor.id) return Response.json({ error: "Cannot change your own role" }, { status: 403 });
    if (!canManageWorkspaceMemberRole(accessRow.role, target.role)) {
      return Response.json({ error: "Cannot modify a member with equal or higher role" }, { status: 403 });
    }
    await db.update(workspaceMembers).set({ role: input.role }).where(eq(workspaceMembers.id, input.memberId));
    if (target.userId && memberSyncSeam?.role) {
      const userId = target.userId;
      const nextRole = input.role;
      fireSync(() => memberSyncSeam.role({ workspaceId: input.workspaceId, userId, role: nextRole }));
    }
    return Response.json({ success: true });
  }
  async function removeMember(input) {
    if (!input.memberId) return Response.json({ error: "Missing memberId" }, { status: 400 });
    if (input.memberId.startsWith("org:")) {
      return Response.json({ error: "Organization owner/admin project access is managed at the organization level" }, { status: 403 });
    }
    const accessRow = await access.getWorkspaceAccess(input.workspaceId, input.actor.id, "admin");
    if (!accessRow) return Response.json({ error: "Workspace not found" }, { status: 404 });
    const [target] = await db.select({ id: workspaceMembers.id, role: workspaceMembers.role, userId: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.id, input.memberId), eq(workspaceMembers.workspaceId, input.workspaceId))).limit(1);
    if (!target) return Response.json({ error: "Member not found" }, { status: 404 });
    if (target.userId === input.actor.id) return Response.json({ error: "Cannot remove yourself from this project" }, { status: 403 });
    if (!canManageWorkspaceMemberRole(accessRow.role, target.role)) {
      return Response.json({ error: "Cannot remove a member with equal or higher role" }, { status: 403 });
    }
    await db.delete(workspaceMembers).where(eq(workspaceMembers.id, input.memberId));
    if (target.userId && memberSyncSeam?.remove) {
      const userId = target.userId;
      fireSync(() => memberSyncSeam.remove({ workspaceId: input.workspaceId, userId }));
    }
    return Response.json({ success: true });
  }
  async function acceptInvite(input) {
    if (!input.token || typeof input.token !== "string") {
      return Response.json({ error: "Missing invite token" }, { status: 400 });
    }
    const [invite] = await db.select().from(workspaceMembers).where(eq(workspaceMembers.inviteToken, input.token)).limit(1);
    if (!invite) return Response.json({ error: "Invalid or expired invite" }, { status: 404 });
    if (invite.acceptedAt) return Response.json({ error: "Invite already accepted" }, { status: 409 });
    if (invite.inviteEmail && invite.inviteEmail.toLowerCase() !== input.actor.email?.toLowerCase()) {
      return Response.json(
        { error: `This invite was sent to ${invite.inviteEmail}. Please sign in with that email.` },
        { status: 403 }
      );
    }
    const [workspace] = await db.select({ id: workspaces.id, organizationId: workspaces.organizationId }).from(workspaces).where(eq(workspaces.id, invite.workspaceId)).limit(1);
    if (!workspace) return Response.json({ error: "Project not found" }, { status: 404 });
    const organizationId = workspace.organizationId;
    const updated = await db.update(workspaceMembers).set({
      userId: input.actor.id,
      acceptedAt: /* @__PURE__ */ new Date(),
      inviteToken: null
    }).where(and(
      eq(workspaceMembers.inviteToken, input.token),
      isNull(workspaceMembers.acceptedAt)
    )).returning({ id: workspaceMembers.id });
    if (updated.length === 0) return Response.json({ error: "Invite already accepted" }, { status: 409 });
    const [orgMember] = await db.insert(organizationMembers).values({
      organizationId,
      userId: input.actor.id,
      role: "member"
    }).onConflictDoUpdate({
      target: [organizationMembers.organizationId, organizationMembers.userId],
      set: { updatedAt: /* @__PURE__ */ new Date() }
    }).returning();
    await db.update(workspaceMembers).set({ organizationMemberId: invite.organizationMemberId ?? orgMember.id }).where(eq(workspaceMembers.id, updated[0].id));
    if (memberSyncSeam?.add) {
      const role = invite.role;
      fireSync(() => memberSyncSeam.add({ workspaceId: invite.workspaceId, userId: input.actor.id, role }));
    }
    return Response.json({
      success: true,
      workspaceId: invite.workspaceId,
      role: invite.role
    });
  }
  async function getUserByEmail(email) {
    const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, email)).limit(1);
    return user ?? null;
  }
  async function getOrganizationMember(organizationId, userId) {
    const [member] = await db.select().from(organizationMembers).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId))).limit(1);
    return member ?? null;
  }
  async function findExistingProjectInvite(workspaceId, email, userId) {
    const byEmail = await db.select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.inviteEmail, email))).limit(1);
    if (byEmail[0]) return byEmail[0];
    if (!userId) return null;
    const byUser = await db.select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))).limit(1);
    return byUser[0] ?? null;
  }
  async function hasPendingOrgInvite(organizationId, email) {
    const [row] = await db.select({ id: workspaceMembers.id }).from(workspaceMembers).innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId)).where(and(
      eq(workspaces.organizationId, organizationId),
      eq(workspaceMembers.inviteEmail, email),
      isNull(workspaceMembers.acceptedAt)
    )).limit(1);
    return Boolean(row);
  }
  return { listMembers, inviteMember, updateMemberRole, removeMember, acceptInvite };
}

export {
  SeatLimitError,
  createMembersApi
};
//# sourceMappingURL=chunk-MEUNTJL5.js.map