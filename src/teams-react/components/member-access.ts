/**
 * Who may change a member's access, and the words for a role shown as text.
 * `MembersPanel` and the settings `MembersSection` both read these, so the two
 * member lists apply one rule.
 */

import { hasWorkspaceRole, type WorkspaceRole } from '../../teams/roles'
import type { MemberView } from '../contracts'
import { ROLE_CAPABILITY } from './RoleSelect'

/**
 * Whether the viewer can change this member's role or remove them: an admin
 * can, except for an owner, an inherited organization admin, or their own row,
 * so no one demotes or removes themselves from a list.
 */
export function canManageMember(member: MemberView, currentRole: WorkspaceRole, currentUserId?: string | null): boolean {
  if (!hasWorkspaceRole(currentRole, 'admin') || member.role === 'owner' || member.inherited) return false
  return !isCurrentMember(member, currentUserId)
}

/** True on the viewer's own row. */
export function isCurrentMember(member: MemberView, currentUserId?: string | null): boolean {
  return currentUserId != null && member.userId === currentUserId
}

/** A role shown as text rather than a picker. */
export function memberRoleLabel(member: MemberView): string {
  if (member.role === 'owner') return member.inherited ? 'Organization admin' : 'Owner'
  return ROLE_CAPABILITY[member.role]
}
