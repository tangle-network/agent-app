import {
  SeatLimitError
} from "../chunk-MEUNTJL5.js";
import "../chunk-DJ4VJIH5.js";
import {
  generateInvitationToken,
  getInvitationExpiresAt,
  inviteUrlForToken,
  normalizeInvitationEmail,
  parseInvitationPermission
} from "../chunk-2DRYTJHI.js";
import {
  hasWorkspaceRole
} from "../chunk-6XIAPIW6.js";

// src/teams/invitations-api.ts
import { and, eq, lte, sql } from "drizzle-orm";
function createInvitationsApi(opts) {
  const { db, tables, access, sendInvitationEmail, enforceSeat, memberSyncSeam } = opts;
  const { organizationMembers, workspaceMembers } = tables;
  const { workspaceInvitations } = opts.invitationsTable;
  const users = opts.userTable;
  const workspaces = opts.workspaceTable;
  const productDisplayName = opts.productDisplayName ?? "A workspace admin";
  function fireSync(op) {
    try {
      Promise.resolve(op()).catch(() => {
      });
    } catch {
    }
  }
  async function createInvitation(input) {
    const now = input.now ?? /* @__PURE__ */ new Date();
    const accessRow = await access.getWorkspaceAccess(input.workspaceId, input.invitedByUserId, "admin");
    if (!accessRow) return { succeeded: false, status: 404, error: "Workspace not found" };
    const permissions = parseInvitationPermission(input.permissions ?? "editor");
    if (!permissions) return { succeeded: false, status: 400, error: "Invalid permissions" };
    if (!hasWorkspaceRole(accessRow.role, permissions)) {
      return { succeeded: false, status: 403, error: "Cannot assign higher permissions than your own" };
    }
    const email = normalizeInvitationEmail(input.email);
    if (!email) return { succeeded: false, status: 400, error: "Missing email" };
    const organizationId = accessRow.organization.id;
    const workspaceName = accessRow.workspace.name;
    await expirePendingInvitations(input.workspaceId, email, now);
    const existingPending = await getPendingInvitation(input.workspaceId, email);
    if (existingPending) return { succeeded: false, status: 409, error: "A pending invitation already exists for this email" };
    const accountCheck = await checkExistingAccountAccess(organizationId, input.workspaceId, email, input.invitedByUserId);
    if (!accountCheck.succeeded) return accountCheck;
    if (enforceSeat && !accountCheck.isExistingOrgMember) {
      try {
        await enforceSeat({ actorId: input.invitedByUserId, organizationId });
      } catch (err) {
        if (err instanceof SeatLimitError) return { succeeded: false, status: err.status, error: err.message };
        throw err;
      }
    }
    const token = generateInvitationToken();
    const expiresAt = getInvitationExpiresAt(now);
    const [created] = await db.insert(workspaceInvitations).values({
      workspaceId: input.workspaceId,
      organizationId,
      email,
      invitedByUserId: input.invitedByUserId,
      permissions,
      token,
      status: "pending",
      emailStatus: "not_sent",
      expiresAt,
      createdAt: now
    }).returning();
    const inviteUrl = inviteUrlForToken(input.origin, token);
    const emailResult = await sendInvitationEmail({
      to: email,
      workspaceName,
      inviterEmail: accountCheck.inviterEmail ?? productDisplayName,
      permission: permissions,
      inviteUrl,
      expiresAt
    });
    const emailStatus = emailResult.succeeded ? "sent" : "failed";
    const [updated] = await db.update(workspaceInvitations).set({ emailStatus, lastSentAt: emailResult.succeeded ? now : null }).where(eq(workspaceInvitations.id, created.id)).returning();
    return {
      succeeded: true,
      value: {
        invitation: toInvitationView(updated, accountCheck.inviterEmail),
        inviteUrl,
        emailError: emailResult.succeeded ? void 0 : emailResult.error
      }
    };
  }
  async function listInvitations(input) {
    const accessRow = await access.getWorkspaceAccess(input.workspaceId, input.userId, "admin");
    if (!accessRow) return { succeeded: false, status: 404, error: "Workspace not found" };
    await expirePendingInvitations(input.workspaceId, void 0, input.now ?? /* @__PURE__ */ new Date());
    const rows = await db.select({ invitation: workspaceInvitations, inviterEmail: users.email }).from(workspaceInvitations).leftJoin(users, eq(users.id, workspaceInvitations.invitedByUserId)).where(eq(workspaceInvitations.workspaceId, input.workspaceId)).orderBy(sql`${workspaceInvitations.createdAt} desc`);
    return {
      succeeded: true,
      value: {
        invitations: rows.map((row) => ({
          ...toInvitationView(row.invitation, row.inviterEmail),
          inviteUrl: inviteUrlForToken(input.origin, row.invitation.token)
        }))
      }
    };
  }
  async function resendInvitation(input) {
    const row = await getInvitationById(input.invitationId);
    if (!row) return { succeeded: false, status: 404, error: "Invitation not found" };
    const accessRow = await access.getWorkspaceAccess(row.invitation.workspaceId, input.userId, "admin");
    if (!accessRow) return { succeeded: false, status: 404, error: "Workspace not found" };
    const now = input.now ?? /* @__PURE__ */ new Date();
    if (row.invitation.status !== "pending") {
      return { succeeded: false, status: 409, error: "Only pending invitations can be resent" };
    }
    if (row.invitation.expiresAt <= now) {
      await markInvitationExpired(row.invitation.id);
      return { succeeded: false, status: 409, error: "Invitation has expired" };
    }
    const workspaceName = accessRow.workspace.name;
    const inviteUrl = inviteUrlForToken(input.origin, row.invitation.token);
    const emailResult = await sendInvitationEmail({
      to: row.invitation.email,
      workspaceName,
      inviterEmail: row.inviterEmail ?? productDisplayName,
      permission: row.invitation.permissions,
      inviteUrl,
      expiresAt: row.invitation.expiresAt
    });
    const [updated] = await db.update(workspaceInvitations).set({
      emailStatus: emailResult.succeeded ? "sent" : "failed",
      lastSentAt: emailResult.succeeded ? now : row.invitation.lastSentAt
    }).where(eq(workspaceInvitations.id, row.invitation.id)).returning();
    return {
      succeeded: true,
      value: {
        invitation: toInvitationView(updated, row.inviterEmail),
        inviteUrl,
        emailError: emailResult.succeeded ? void 0 : emailResult.error
      }
    };
  }
  async function revokeInvitation(input) {
    const row = await getInvitationById(input.invitationId);
    if (!row) return { succeeded: false, status: 404, error: "Invitation not found" };
    const accessRow = await access.getWorkspaceAccess(row.invitation.workspaceId, input.userId, "admin");
    if (!accessRow) return { succeeded: false, status: 404, error: "Workspace not found" };
    if (row.invitation.status !== "pending") {
      return { succeeded: false, status: 409, error: "Only pending invitations can be revoked" };
    }
    const [updated] = await db.update(workspaceInvitations).set({ status: "revoked", revokedAt: input.now ?? /* @__PURE__ */ new Date() }).where(and(eq(workspaceInvitations.id, row.invitation.id), eq(workspaceInvitations.status, "pending"))).returning();
    if (!updated) return { succeeded: false, status: 409, error: "The invitation changed. Reload it before continuing." };
    return { succeeded: true, value: { invitation: toInvitationView(updated, row.inviterEmail) } };
  }
  async function getPreview(token, now = /* @__PURE__ */ new Date()) {
    const row = await getInvitationByToken(token);
    if (!row) return { succeeded: false, status: 404, error: "Invitation not found" };
    let invitation = row.invitation;
    if (invitation.status === "pending" && invitation.expiresAt <= now) {
      invitation = await markInvitationExpired(invitation.id);
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
        expiresAt: invitation.expiresAt
      }
    };
  }
  async function acceptInvitation(input) {
    const now = input.now ?? /* @__PURE__ */ new Date();
    const row = await getInvitationByToken(input.token);
    if (!row) return { succeeded: false, status: 404, error: "Invitation not found" };
    let invitation = row.invitation;
    if (invitation.status === "pending" && invitation.expiresAt <= now) {
      invitation = await markInvitationExpired(invitation.id);
    }
    const [currentUser] = await db.select({ id: users.id, email: users.email, emailVerified: users.emailVerified }).from(users).where(eq(users.id, input.userId)).limit(1);
    if (!currentUser) return { succeeded: false, status: 401, error: "Authentication required" };
    if (normalizeInvitationEmail(currentUser.email) !== invitation.email) {
      return { succeeded: false, status: 403, error: "Sign in with the invited email address to accept this invitation" };
    }
    const collisionCheck = await findUsersByNormalizedEmail(invitation.email);
    if (collisionCheck.length > 1) {
      return {
        succeeded: false,
        status: 409,
        error: "Multiple accounts use this email. Contact support to reconcile before accepting this invitation."
      };
    }
    let orgMember = await getOrganizationMember(invitation.organizationId, currentUser.id);
    if (orgMember?.role === "owner" || orgMember?.role === "admin") {
      return { succeeded: false, status: 409, error: "This user already has account-level access." };
    }
    if (invitation.status === "accepted") {
      const existing = orgMember ? await getWorkspaceMemberByOrganizationMember(invitation.workspaceId, orgMember.id) : null;
      if (existing) return { succeeded: true, value: { workspaceId: invitation.workspaceId } };
      return { succeeded: false, status: 409, error: "Invitation has already been accepted" };
    }
    if (invitation.status === "expired") return { succeeded: false, status: 409, error: "Invitation has expired" };
    if (invitation.status === "revoked") return { succeeded: false, status: 409, error: "Invitation has been revoked" };
    if (!orgMember) {
      const [inserted] = await db.insert(organizationMembers).values({
        organizationId: invitation.organizationId,
        userId: currentUser.id,
        role: "member",
        createdAt: now,
        updatedAt: now
      }).returning();
      if (!inserted) return { succeeded: false, status: 500, error: "Failed to create organization membership" };
      orgMember = inserted;
    }
    const existingMember = await getWorkspaceMemberByOrganizationMember(invitation.workspaceId, orgMember.id);
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
        acceptedAt: now
      });
      if (memberSyncSeam?.add) {
        const userId = currentUser.id;
        const role = invitation.permissions;
        fireSync(() => memberSyncSeam.add({ workspaceId: invitation.workspaceId, userId, role }));
      }
    }
    const [accepted] = await db.update(workspaceInvitations).set({ status: "accepted", acceptedAt: now }).where(and(eq(workspaceInvitations.id, invitation.id), eq(workspaceInvitations.status, "pending"))).returning();
    if (!accepted) {
      await db.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, invitation.workspaceId), eq(workspaceMembers.userId, currentUser.id)));
      return { succeeded: false, status: 409, error: "The invitation changed. Reload it before continuing." };
    }
    return { succeeded: true, value: { workspaceId: invitation.workspaceId } };
  }
  async function expirePendingInvitations(workspaceId, email, now) {
    const conditions = [
      eq(workspaceInvitations.workspaceId, workspaceId),
      eq(workspaceInvitations.status, "pending"),
      lte(workspaceInvitations.expiresAt, now)
    ];
    if (email) conditions.push(eq(workspaceInvitations.email, email));
    await db.update(workspaceInvitations).set({ status: "expired" }).where(and(...conditions));
  }
  async function getPendingInvitation(workspaceId, email) {
    const [invitation] = await db.select({ id: workspaceInvitations.id }).from(workspaceInvitations).where(and(
      eq(workspaceInvitations.workspaceId, workspaceId),
      eq(workspaceInvitations.email, email),
      eq(workspaceInvitations.status, "pending")
    )).limit(1);
    return invitation ?? null;
  }
  async function checkExistingAccountAccess(organizationId, workspaceId, email, invitedByUserId) {
    const matchingUsers = await findUsersByNormalizedEmail(email);
    const [inviter] = await db.select({ email: users.email }).from(users).where(eq(users.id, invitedByUserId)).limit(1);
    if (matchingUsers.length > 1) {
      return {
        succeeded: false,
        status: 409,
        error: "Multiple accounts use this email. Contact support to reconcile before inviting this user."
      };
    }
    const existingUser = matchingUsers[0];
    if (!existingUser) return { succeeded: true, inviterEmail: inviter?.email ?? null, isExistingOrgMember: false };
    const orgMember = await getOrganizationMember(organizationId, existingUser.id);
    if (orgMember?.role === "owner" || orgMember?.role === "admin") {
      return { succeeded: false, status: 409, error: "This user already has account-level access." };
    }
    if (orgMember) {
      const workspaceMember = await getWorkspaceMemberByOrganizationMember(workspaceId, orgMember.id);
      if (workspaceMember) return { succeeded: false, status: 409, error: "User is already a workspace member" };
    }
    return { succeeded: true, inviterEmail: inviter?.email ?? null, isExistingOrgMember: Boolean(orgMember) };
  }
  async function findUsersByNormalizedEmail(email) {
    return db.select({ id: users.id, email: users.email, emailVerified: users.emailVerified }).from(users).where(sql`lower(${users.email}) = ${email}`);
  }
  async function getOrganizationMember(organizationId, userId) {
    const [member] = await db.select().from(organizationMembers).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId))).limit(1);
    return member ?? null;
  }
  async function getWorkspaceMemberByOrganizationMember(workspaceId, organizationMemberId) {
    const [member] = await db.select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.organizationMemberId, organizationMemberId)
    )).limit(1);
    return member ?? null;
  }
  async function getInvitationById(invitationId) {
    const [row] = await db.select({ invitation: workspaceInvitations, inviterEmail: users.email }).from(workspaceInvitations).leftJoin(users, eq(users.id, workspaceInvitations.invitedByUserId)).where(eq(workspaceInvitations.id, invitationId)).limit(1);
    return row ?? null;
  }
  async function getInvitationByToken(token) {
    const [row] = await db.select({
      invitation: workspaceInvitations,
      workspaceName: workspaces.name,
      inviterEmail: users.email
    }).from(workspaceInvitations).innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId)).leftJoin(users, eq(users.id, workspaceInvitations.invitedByUserId)).where(eq(workspaceInvitations.token, token)).limit(1);
    return row ?? null;
  }
  async function markInvitationExpired(invitationId) {
    const [updated] = await db.update(workspaceInvitations).set({ status: "expired" }).where(eq(workspaceInvitations.id, invitationId)).returning();
    return updated;
  }
  function toInvitationView(invitation, inviterEmail) {
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
      lastSentAt: invitation.lastSentAt
    };
  }
  return { createInvitation, listInvitations, resendInvitation, revokeInvitation, getPreview, acceptInvitation };
}
export {
  SeatLimitError,
  createInvitationsApi
};
//# sourceMappingURL=invitations-api.js.map