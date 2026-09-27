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
export declare const WORKSPACE_ROLES: readonly ['viewer', 'editor', 'admin', 'owner'];
/** Resolve the union type of all possible workspace role string literals from WORKSPACE_ROLES array */
export type WorkspaceRole = typeof WORKSPACE_ROLES[number];
/** Define the list of roles that can be assigned within a workspace */
export declare const ASSIGNABLE_WORKSPACE_ROLES: readonly ['viewer', 'editor', 'admin'];
/** Resolve the set of roles that can be assigned within a workspace */
export type AssignableWorkspaceRole = typeof ASSIGNABLE_WORKSPACE_ROLES[number];
/** Define the set of fixed roles available within an organization */
export declare const ORGANIZATION_ROLES: readonly ['owner', 'admin', 'member', 'billing'];
/** Resolve a role string from the predefined list of organization roles */
export type OrganizationRole = typeof ORGANIZATION_ROLES[number];
/** Define access levels for workspace collaboration as either read or write */
export type WorkspaceCollaborationAccess = 'read' | 'write';
/** Define user roles available within a sandbox workspace environment */
export type SandboxWorkspaceRole = 'owner' | 'admin' | 'developer' | 'viewer';
/** Map workspace roles to their corresponding hierarchical rank values */
export declare const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number>;
/** Map organization roles to their hierarchical rank for permission and access control purposes */
export declare const ORGANIZATION_ROLE_RANK: Record<OrganizationRole, number>;
/** True when `actual` is at least `minimum` on the workspace ladder. */
export declare function hasWorkspaceRole(actual: WorkspaceRole, minimum: WorkspaceRole): boolean;
/** True when `actual` is at least `minimum` on the organization ladder. */
export declare function hasOrganizationRole(actual: OrganizationRole, minimum: OrganizationRole): boolean;
/** Determine if a value is a valid assignable workspace role among viewer, editor, or admin */
export declare function isAssignableWorkspaceRole(value: unknown): value is AssignableWorkspaceRole;
/** Org owners and admins are workspace owners across the whole org. */
export declare function organizationRoleGrantsWorkspaceOwner(role: OrganizationRole | string | null | undefined): boolean;
/**
 * The effective workspace role a request runs at: org owner/admin → owner of
 * every workspace; otherwise the explicit per-workspace role (or null = no
 * access). This is the single fold every access check goes through.
 */
export declare function resolveWorkspaceRole(organizationRole: OrganizationRole | string | null | undefined, workspaceRole: WorkspaceRole | null | undefined): WorkspaceRole | null;
/**
 * Whether `actorRole` may set/clear a member currently at `targetRole`. Owners
 * can manage anyone; everyone else can only manage members strictly below
 * their own rank (an admin cannot demote another admin or an owner).
 */
export declare function canManageWorkspaceMemberRole(actorRole: WorkspaceRole, targetRole: WorkspaceRole): boolean;
/** Map a workspace role to the corresponding collaboration access level */
export declare function workspaceRoleToCollaborationAccess(role: WorkspaceRole): WorkspaceCollaborationAccess;
/** Map a workspace role to its corresponding sandbox workspace role */
export declare function workspaceRoleToSandboxRole(role: WorkspaceRole): SandboxWorkspaceRole;
