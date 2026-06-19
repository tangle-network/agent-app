import { describe, it, expect } from 'vitest'
import {
  WORKSPACE_ROLES,
  ORGANIZATION_ROLES,
  hasWorkspaceRole,
  hasOrganizationRole,
  isAssignableWorkspaceRole,
  organizationRoleGrantsWorkspaceOwner,
  resolveWorkspaceRole,
  canManageWorkspaceMemberRole,
  workspaceRoleToCollaborationAccess,
  workspaceRoleToSandboxRole,
} from '../../src/teams/roles'
import {
  generateInviteToken,
  isInviteTokenShape,
  validateInviteToken,
} from '../../src/teams/invite'

describe('workspace role ladder', () => {
  it('ranks viewer < editor < admin < owner', () => {
    expect(hasWorkspaceRole('owner', 'admin')).toBe(true)
    expect(hasWorkspaceRole('admin', 'editor')).toBe(true)
    expect(hasWorkspaceRole('editor', 'viewer')).toBe(true)
    expect(hasWorkspaceRole('viewer', 'editor')).toBe(false)
    expect(hasWorkspaceRole('editor', 'admin')).toBe(false)
  })

  it('treats equal roles as satisfying the minimum', () => {
    for (const role of WORKSPACE_ROLES) {
      expect(hasWorkspaceRole(role, role)).toBe(true)
    }
  })
})

describe('organization role ladder', () => {
  it('ranks member < billing < admin < owner', () => {
    expect(hasOrganizationRole('owner', 'admin')).toBe(true)
    expect(hasOrganizationRole('admin', 'billing')).toBe(true)
    expect(hasOrganizationRole('billing', 'member')).toBe(true)
    expect(hasOrganizationRole('member', 'admin')).toBe(false)
  })

  it('exposes the four canonical org roles', () => {
    expect([...ORGANIZATION_ROLES]).toEqual(['owner', 'admin', 'member', 'billing'])
  })
})

describe('isAssignableWorkspaceRole', () => {
  it('accepts viewer/editor/admin and rejects owner + junk', () => {
    expect(isAssignableWorkspaceRole('viewer')).toBe(true)
    expect(isAssignableWorkspaceRole('editor')).toBe(true)
    expect(isAssignableWorkspaceRole('admin')).toBe(true)
    expect(isAssignableWorkspaceRole('owner')).toBe(false)
    expect(isAssignableWorkspaceRole('superadmin')).toBe(false)
    expect(isAssignableWorkspaceRole(null)).toBe(false)
    expect(isAssignableWorkspaceRole(42)).toBe(false)
  })
})

describe('resolveWorkspaceRole', () => {
  it('org owner/admin become workspace owner regardless of workspace role', () => {
    expect(resolveWorkspaceRole('owner', null)).toBe('owner')
    expect(resolveWorkspaceRole('admin', 'viewer')).toBe('owner')
  })

  it('org member/billing fall through to the explicit workspace role', () => {
    expect(resolveWorkspaceRole('member', 'editor')).toBe('editor')
    expect(resolveWorkspaceRole('billing', 'viewer')).toBe('viewer')
  })

  it('returns null when no org-owner grant and no workspace role', () => {
    expect(resolveWorkspaceRole('member', null)).toBeNull()
    expect(resolveWorkspaceRole(null, undefined)).toBeNull()
  })

  it('organizationRoleGrantsWorkspaceOwner only for owner/admin', () => {
    expect(organizationRoleGrantsWorkspaceOwner('owner')).toBe(true)
    expect(organizationRoleGrantsWorkspaceOwner('admin')).toBe(true)
    expect(organizationRoleGrantsWorkspaceOwner('member')).toBe(false)
    expect(organizationRoleGrantsWorkspaceOwner('billing')).toBe(false)
    expect(organizationRoleGrantsWorkspaceOwner(null)).toBe(false)
  })
})

describe('canManageWorkspaceMemberRole', () => {
  it('owner can manage anyone including another owner', () => {
    expect(canManageWorkspaceMemberRole('owner', 'owner')).toBe(true)
    expect(canManageWorkspaceMemberRole('owner', 'admin')).toBe(true)
  })

  it('admin can manage strictly-lower roles only', () => {
    expect(canManageWorkspaceMemberRole('admin', 'editor')).toBe(true)
    expect(canManageWorkspaceMemberRole('admin', 'viewer')).toBe(true)
    expect(canManageWorkspaceMemberRole('admin', 'admin')).toBe(false)
    expect(canManageWorkspaceMemberRole('admin', 'owner')).toBe(false)
  })
})

describe('role mappings', () => {
  it('viewer maps to read access, everything else to write', () => {
    expect(workspaceRoleToCollaborationAccess('viewer')).toBe('read')
    expect(workspaceRoleToCollaborationAccess('editor')).toBe('write')
    expect(workspaceRoleToCollaborationAccess('owner')).toBe('write')
  })

  it('maps workspace roles to sandbox roles (editor → developer)', () => {
    expect(workspaceRoleToSandboxRole('owner')).toBe('owner')
    expect(workspaceRoleToSandboxRole('admin')).toBe('admin')
    expect(workspaceRoleToSandboxRole('editor')).toBe('developer')
    expect(workspaceRoleToSandboxRole('viewer')).toBe('viewer')
  })
})

describe('invite tokens', () => {
  it('generates unguessable, url-safe, unique tokens', () => {
    const a = generateInviteToken()
    const b = generateInviteToken()
    expect(a).not.toBe(b)
    expect(isInviteTokenShape(a)).toBe(true)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.length).toBeGreaterThanOrEqual(16)
  })

  it('rejects malformed token shapes', () => {
    expect(isInviteTokenShape('short')).toBe(false)
    expect(isInviteTokenShape('has spaces in it here')).toBe(false)
    expect(isInviteTokenShape('')).toBe(false)
    expect(isInviteTokenShape(null)).toBe(false)
  })

  it('validates a fresh, unaccepted invite as ok', () => {
    expect(validateInviteToken({ acceptedAt: null }).ok).toBe(true)
  })

  it('rejects an already-accepted invite', () => {
    const result = validateInviteToken({ acceptedAt: new Date() })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('already-accepted')
  })

  it('rejects an expired invite', () => {
    const result = validateInviteToken(
      { acceptedAt: null, expiresAt: new Date('2020-01-01') },
      { now: new Date('2026-01-01') },
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('expired')
  })

  it('rejects an email mismatch (case-insensitive)', () => {
    const result = validateInviteToken(
      { acceptedAt: null, inviteEmail: 'invited@example.com' },
      { acceptingEmail: 'someone-else@example.com' },
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('email-mismatch')
  })

  it('accepts a matching email regardless of case', () => {
    const result = validateInviteToken(
      { acceptedAt: null, inviteEmail: 'Invited@Example.com' },
      { acceptingEmail: 'invited@example.com' },
    )
    expect(result.ok).toBe(true)
  })

  it('does not enforce email when the invite is open (no inviteEmail)', () => {
    expect(validateInviteToken({ acceptedAt: null }, { acceptingEmail: 'anyone@x.com' }).ok).toBe(true)
  })
})
