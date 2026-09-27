import {
  hasOrganizationRole,
  hasWorkspaceRole,
  resolveWorkspaceRole
} from "../chunk-6XIAPIW6.js";

// src/teams/drizzle/schema.ts
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
var hexId = () => text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`);
var createdAt = () => integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`);
var updatedAt = () => integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`);
function createTeamTables(opts) {
  const { userTable, workspaceTable } = opts;
  const organizations = sqliteTable("organization", {
    id: hexId(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    kind: text("kind", { enum: ["personal", "team"] }).notNull().default("personal"),
    createdBy: text("created_by").notNull().references(() => userTable.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  }, (table) => [
    index("idx_organization_created_by").on(table.createdBy)
  ]);
  const organizationMembers = sqliteTable("organization_member", {
    id: hexId(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => userTable.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member", "billing"] }).notNull().default("member"),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  }, (table) => [
    uniqueIndex("uniq_org_member_user").on(table.organizationId, table.userId),
    index("idx_org_member_user").on(table.userId)
  ]);
  const workspaceMembers = sqliteTable("workspace_member", {
    id: hexId(),
    workspaceId: text("workspace_id").notNull().references(() => workspaceTable.id, { onDelete: "cascade" }),
    organizationMemberId: text("organization_member_id").references(() => organizationMembers.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => userTable.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "editor", "viewer"] }).notNull().default("editor"),
    invitedBy: text("invited_by"),
    inviteEmail: text("invite_email"),
    inviteToken: text("invite_token"),
    invitedAt: integer("invited_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    acceptedAt: integer("accepted_at", { mode: "timestamp" })
  }, (table) => [
    uniqueIndex("uniq_workspace_member_org_member").on(table.workspaceId, table.organizationMemberId),
    index("idx_workspace_member_user").on(table.workspaceId, table.userId),
    index("idx_member_user").on(table.userId),
    uniqueIndex("idx_member_invite_token").on(table.inviteToken)
  ]);
  return { organizations, organizationMembers, workspaceMembers };
}

// src/teams/drizzle/invitations-schema.ts
import { sql as sql2 } from "drizzle-orm";
import { index as index2, integer as integer2, sqliteTable as sqliteTable2, text as text2, uniqueIndex as uniqueIndex2 } from "drizzle-orm/sqlite-core";
function createWorkspaceInvitationTable(opts) {
  const { userTable, workspaceTable, organizationTable } = opts;
  const workspaceInvitations = sqliteTable2("workspace_invitation", {
    id: text2("id").primaryKey().default(sql2`(lower(hex(randomblob(16))))`),
    workspaceId: text2("workspace_id").notNull().references(() => workspaceTable.id, { onDelete: "cascade" }),
    organizationId: text2("organization_id").notNull().references(() => organizationTable.id, { onDelete: "cascade" }),
    email: text2("email").notNull(),
    invitedByUserId: text2("invited_by_user_id").notNull().references(() => userTable.id, { onDelete: "cascade" }),
    permissions: text2("permissions", { enum: ["admin", "editor", "viewer"] }).notNull().default("editor"),
    token: text2("token").notNull().unique(),
    status: text2("status", { enum: ["pending", "accepted", "expired", "revoked"] }).notNull().default("pending"),
    emailStatus: text2("email_status", { enum: ["not_sent", "sent", "failed"] }).notNull().default("not_sent"),
    expiresAt: integer2("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer2("created_at", { mode: "timestamp" }).notNull().default(sql2`(unixepoch())`),
    acceptedAt: integer2("accepted_at", { mode: "timestamp" }),
    revokedAt: integer2("revoked_at", { mode: "timestamp" }),
    lastSentAt: integer2("last_sent_at", { mode: "timestamp" })
  }, (table) => [
    uniqueIndex2("uniq_workspace_invitation_token").on(table.token),
    index2("idx_workspace_invitation_workspace").on(table.workspaceId, table.createdAt),
    index2("idx_workspace_invitation_email").on(table.email),
    index2("idx_workspace_invitation_workspace_email_status").on(table.workspaceId, table.email, table.status)
  ]);
  return { workspaceInvitations };
}

// src/teams/drizzle/access.ts
import { and, desc, eq, isNotNull } from "drizzle-orm";
function createWorkspaceAccess(opts) {
  const { db, tables, workspaceTable } = opts;
  const { organizations, organizationMembers, workspaceMembers } = tables;
  const workspaces = workspaceTable;
  async function getWorkspaceAccess(workspaceId, userId, minRole = "viewer") {
    const [row] = await db.select({
      workspace: workspaces,
      organization: organizations,
      organizationMember: organizationMembers,
      projectRole: workspaceMembers.role,
      acceptedAt: workspaceMembers.acceptedAt
    }).from(workspaces).innerJoin(organizations, eq(organizations.id, workspaces.organizationId)).innerJoin(organizationMembers, and(
      eq(organizationMembers.organizationId, workspaces.organizationId),
      eq(organizationMembers.userId, userId)
    )).leftJoin(workspaceMembers, and(
      eq(workspaceMembers.workspaceId, workspaces.id),
      eq(workspaceMembers.organizationMemberId, organizationMembers.id),
      isNotNull(workspaceMembers.acceptedAt)
    )).where(eq(workspaces.id, workspaceId)).limit(1);
    if (!row) return null;
    const role = resolveWorkspaceRole(row.organizationMember.role, row.projectRole);
    if (!role) return null;
    if (!hasWorkspaceRole(role, minRole)) return null;
    return {
      workspace: row.workspace,
      organization: row.organization,
      organizationMember: row.organizationMember,
      role
    };
  }
  async function requireWorkspaceAccess(workspaceId, userId, minRole = "viewer") {
    const access = await getWorkspaceAccess(workspaceId, userId, minRole);
    if (!access) throw new Response("Workspace not found", { status: 404 });
    return access;
  }
  async function listUserWorkspaces(userId) {
    const rows = await db.select({
      workspace: workspaces,
      organization: organizations,
      organizationMember: organizationMembers,
      projectRole: workspaceMembers.role
    }).from(workspaces).innerJoin(organizations, eq(organizations.id, workspaces.organizationId)).innerJoin(organizationMembers, and(
      eq(organizationMembers.organizationId, workspaces.organizationId),
      eq(organizationMembers.userId, userId)
    )).leftJoin(workspaceMembers, and(
      eq(workspaceMembers.workspaceId, workspaces.id),
      eq(workspaceMembers.organizationMemberId, organizationMembers.id),
      isNotNull(workspaceMembers.acceptedAt)
    )).orderBy(desc(workspaces.updatedAt));
    return rows.flatMap((row) => {
      const role = resolveWorkspaceRole(row.organizationMember.role, row.projectRole);
      if (!role) return [];
      return [{
        ...row.workspace,
        organizationId: row.organization.id,
        organizationName: row.organization.name,
        role
      }];
    });
  }
  return { getWorkspaceAccess, requireWorkspaceAccess, listUserWorkspaces };
}
function createOrganizationAccess(opts) {
  const { db, tables } = opts;
  const { organizations, organizationMembers } = tables;
  async function getOrganizationAccess(organizationId, userId, minRole = "member") {
    const [row] = await db.select({
      organization: organizations,
      member: organizationMembers
    }).from(organizationMembers).innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId)).where(and(
      eq(organizationMembers.organizationId, organizationId),
      eq(organizationMembers.userId, userId)
    )).limit(1);
    if (!row) return null;
    const role = row.member.role;
    if (!hasOrganizationRole(role, minRole)) return null;
    return { organization: row.organization, member: row.member, role };
  }
  async function requireOrganizationAccess(organizationId, userId, minRole = "member") {
    const access = await getOrganizationAccess(organizationId, userId, minRole);
    if (!access) throw new Response("Organization not found", { status: 404 });
    return access;
  }
  return { getOrganizationAccess, requireOrganizationAccess };
}

// src/teams/drizzle/personal-organization.ts
import { and as and2, eq as eq2 } from "drizzle-orm";
function createEnsurePersonalOrganization(opts) {
  const { db, tables } = opts;
  const { organizations, organizationMembers } = tables;
  return async function ensurePersonalOrganization(user) {
    const [existing] = await db.select({
      organization: organizations,
      member: organizationMembers
    }).from(organizationMembers).innerJoin(organizations, eq2(organizations.id, organizationMembers.organizationId)).where(and2(
      eq2(organizationMembers.userId, user.id),
      eq2(organizations.kind, "personal")
    )).limit(1);
    if (existing) {
      return {
        organization: existing.organization,
        member: existing.member,
        role: existing.member.role
      };
    }
    const orgName = user.name?.trim() || user.email?.split("@")[0] || "Personal";
    const slug = `personal-${user.id}`;
    const [organization] = await db.insert(organizations).values({
      name: `${orgName}'s Organization`,
      slug,
      kind: "personal",
      createdBy: user.id
    }).onConflictDoUpdate({
      target: organizations.slug,
      set: { updatedAt: /* @__PURE__ */ new Date() }
    }).returning();
    const org = organization;
    const [member] = await db.insert(organizationMembers).values({
      organizationId: org.id,
      userId: user.id,
      role: "owner"
    }).onConflictDoUpdate({
      target: [organizationMembers.organizationId, organizationMembers.userId],
      set: { role: "owner", updatedAt: /* @__PURE__ */ new Date() }
    }).returning();
    return { organization: org, member, role: "owner" };
  };
}
export {
  createEnsurePersonalOrganization,
  createOrganizationAccess,
  createTeamTables,
  createWorkspaceAccess,
  createWorkspaceInvitationTable
};
//# sourceMappingURL=drizzle.js.map