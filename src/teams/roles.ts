/**
 * Pure role algebra for the teams capability — the tenancy/membership model
 * shared across the fleet. Zero dependencies: no drizzle, no env, no react, no
 * I/O. The DB layer (`./teams/drizzle`), the members API (`./teams/members-api`)
 * and the React surface (`./teams-react`) all build on these functions; this
 * leaf imports nothing back, so a consumer can pull just the role math.
 *
 * Two role ladders, deliberately distinct:
 *   - Organization roles rank the tenant (who owns/administers the org and its
 *     billing). An org owner/admin is an owner of every workspace under it.
 *   - Workspace roles rank a single workspace. They are the access primitive
 *     every route checks via `hasWorkspaceRole(actual, minimum)`.
 *
 * `resolveWorkspaceRole` is the bridge: it folds the org role and the
 * per-workspace role into the one effective workspace role a request runs at.
 */

export const WORKSPACE_ROLES = ['viewer', 'editor', 'admin', 'owner'] as const
/** Resolve the union type of all possible workspace role string literals from WORKSPACE_ROLES array */
export type WorkspaceRole = typeof WORKSPACE_ROLES[number]

/** Define the list of roles that can be assigned within a workspace */
export const ASSIGNABLE_WORKSPACE_ROLES = ['viewer', 'editor', 'admin'] as const
/** Resolve the set of roles that can be assigned within a workspace */
export type AssignableWorkspaceRole = typeof ASSIGNABLE_WORKSPACE_ROLES[number]

/** Define the set of fixed roles available within an organization */
export const ORGANIZATION_ROLES = ['owner', 'admin', 'member', 'billing'] as const
/** Resolve a role string from the predefined list of organization roles */
export type OrganizationRole = typeof ORGANIZATION_ROLES[number]

/** Define access levels for workspace collaboration as either read or write */
export type WorkspaceCollaborationAccess = 'read' | 'write'
/** Define user roles available within a sandbox workspace environment */
export type SandboxWorkspaceRole = 'owner' | 'admin' | 'developer' | 'viewer'

/** Map workspace roles to their corresponding hierarchical rank values */
export const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
}

/** Map organization roles to their hierarchical rank for permission and access control purposes */
export const ORGANIZATION_ROLE_RANK: Record<OrganizationRole, number> = {
  member: 0,
  billing: 1,
  admin: 2,
  owner: 3,
}

/** True when `actual` is at least `minimum` on the workspace ladder. */
export function hasWorkspaceRole(actual: WorkspaceRole, minimum: WorkspaceRole): boolean {
  return WORKSPACE_ROLE_RANK[actual] >= WORKSPACE_ROLE_RANK[minimum]
}

/** True when `actual` is at least `minimum` on the organization ladder. */
export function hasOrganizationRole(actual: OrganizationRole, minimum: OrganizationRole): boolean {
  return ORGANIZATION_ROLE_RANK[actual] >= ORGANIZATION_ROLE_RANK[minimum]
}

/** Determine if a value is a valid assignable workspace role among viewer, editor, or admin */
export function isAssignableWorkspaceRole(value: unknown): value is AssignableWorkspaceRole {
  return typeof value === 'string' && ASSIGNABLE_WORKSPACE_ROLES.includes(value as AssignableWorkspaceRole)
}

/** Org owners and admins are workspace owners across the whole org. */
export function organizationRoleGrantsWorkspaceOwner(role: OrganizationRole | string | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

/**
 * The effective workspace role a request runs at: org owner/admin → owner of
 * every workspace; otherwise the explicit per-workspace role (or null = no
 * access). This is the single fold every access check goes through.
 */
export function resolveWorkspaceRole(
  organizationRole: OrganizationRole | string | null | undefined,
  workspaceRole: WorkspaceRole | null | undefined,
): WorkspaceRole | null {
  return organizationRoleGrantsWorkspaceOwner(organizationRole) ? 'owner' : workspaceRole ?? null
}

/**
 * Whether `actorRole` may set/clear a member currently at `targetRole`. Owners
 * can manage anyone; everyone else can only manage members strictly below
 * their own rank (an admin cannot demote another admin or an owner).
 */
export function canManageWorkspaceMemberRole(actorRole: WorkspaceRole, targetRole: WorkspaceRole): boolean {
  return actorRole === 'owner' || !hasWorkspaceRole(targetRole, actorRole)
}

/** Map a workspace role to the corresponding collaboration access level */
export function workspaceRoleToCollaborationAccess(role: WorkspaceRole): WorkspaceCollaborationAccess {
  return role === 'viewer' ? 'read' : 'write'
}

/** Map a workspace role to its corresponding sandbox workspace role */
export function workspaceRoleToSandboxRole(role: WorkspaceRole): SandboxWorkspaceRole {
  const mapping: Record<WorkspaceRole, SandboxWorkspaceRole> = {
    owner: 'owner',
    admin: 'admin',
    editor: 'developer',
    viewer: 'viewer',
  }
  return mapping[role]
}
