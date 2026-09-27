// src/teams/roles.ts
var WORKSPACE_ROLES = ["viewer", "editor", "admin", "owner"];
var ASSIGNABLE_WORKSPACE_ROLES = ["viewer", "editor", "admin"];
var ORGANIZATION_ROLES = ["owner", "admin", "member", "billing"];
var WORKSPACE_ROLE_RANK = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3
};
var ORGANIZATION_ROLE_RANK = {
  member: 0,
  billing: 1,
  admin: 2,
  owner: 3
};
function hasWorkspaceRole(actual, minimum) {
  return WORKSPACE_ROLE_RANK[actual] >= WORKSPACE_ROLE_RANK[minimum];
}
function hasOrganizationRole(actual, minimum) {
  return ORGANIZATION_ROLE_RANK[actual] >= ORGANIZATION_ROLE_RANK[minimum];
}
function isAssignableWorkspaceRole(value) {
  return typeof value === "string" && ASSIGNABLE_WORKSPACE_ROLES.includes(value);
}
function organizationRoleGrantsWorkspaceOwner(role) {
  return role === "owner" || role === "admin";
}
function resolveWorkspaceRole(organizationRole, workspaceRole) {
  return organizationRoleGrantsWorkspaceOwner(organizationRole) ? "owner" : workspaceRole ?? null;
}
function canManageWorkspaceMemberRole(actorRole, targetRole) {
  return actorRole === "owner" || !hasWorkspaceRole(targetRole, actorRole);
}
function workspaceRoleToCollaborationAccess(role) {
  return role === "viewer" ? "read" : "write";
}
function workspaceRoleToSandboxRole(role) {
  const mapping = {
    owner: "owner",
    admin: "admin",
    editor: "developer",
    viewer: "viewer"
  };
  return mapping[role];
}

export {
  WORKSPACE_ROLES,
  ASSIGNABLE_WORKSPACE_ROLES,
  ORGANIZATION_ROLES,
  WORKSPACE_ROLE_RANK,
  ORGANIZATION_ROLE_RANK,
  hasWorkspaceRole,
  hasOrganizationRole,
  isAssignableWorkspaceRole,
  organizationRoleGrantsWorkspaceOwner,
  resolveWorkspaceRole,
  canManageWorkspaceMemberRole,
  workspaceRoleToCollaborationAccess,
  workspaceRoleToSandboxRole
};
//# sourceMappingURL=chunk-6XIAPIW6.js.map