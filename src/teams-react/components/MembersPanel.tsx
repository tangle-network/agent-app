/**
 * Workspace members panel: list members, invite by email + role, change a
 * member's role, remove a member. Fully callback-driven — the host supplies the
 * data and the async `onInvite`/`onChangeRole`/`onRemove` callbacks (backed by
 * `./teams/members-api`), so this imports no app router, fetch client, or toast.
 * Styled with the shipped Tangle Quiet tokens (`var(--*)`).
 *
 * Role gating mirrors the API: only admins/owners see role selects and the
 * remove control; inherited org owners and explicit owners are not editable
 * here (org-level concern). The invite role select offers `admin` only to
 * admins/owners.
 */

import type { WorkspaceRole } from '../../teams/roles'
import { hasWorkspaceRole } from '../../teams/roles'
import type { MemberView, MembersPanelProps } from '../contracts'
import { InviteForm } from './InviteForm'
import { RoleSelect } from './RoleSelect'

export function MembersPanel({
  members,
  currentRole,
  onInvite,
  onChangeRole,
  onRemove,
  onNotice,
  showInviteForm = true,
}: MembersPanelProps) {
  const canManage = hasWorkspaceRole(currentRole, 'admin')

  function notify(kind: 'success' | 'error', message: string) {
    onNotice?.({ kind, message })
  }

  async function invite(input: { email: string; role: WorkspaceRole }): Promise<boolean> {
    try {
      const result = await onInvite(input)
      notify('success', result && 'inviteUrl' in result && result.inviteUrl ? `Invite link ready for ${input.email}` : `Invited ${input.email}`)
      return true
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to invite')
      return false
    }
  }

  async function changeRole(memberId: string, role: WorkspaceRole) {
    try {
      await onChangeRole({ memberId, role })
      notify('success', 'Role updated')
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to update role')
    }
  }

  async function remove(memberId: string) {
    try {
      await onRemove({ memberId })
      notify('success', 'Member removed')
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to remove member')
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-[var(--text-primary)]">Members</h4>
        <span className="text-sm text-[var(--text-muted)]">{members.length} total</span>
      </div>
      <div className="flex flex-col gap-2">
        {members.map((member) => (
          <MemberRow
            key={member.id}
            member={member}
            canManage={canManage}
            onChangeRole={changeRole}
            onRemove={remove}
          />
        ))}
        {members.length === 0 && (
          <p className="text-sm text-[var(--text-muted)]">No team members yet.</p>
        )}
      </div>

      {canManage && showInviteForm && (
        <div className="border-t border-[var(--border-default)] pt-3">
          <InviteForm label="Invite member" placeholder="Email address" onInvite={invite} />
        </div>
      )}
    </section>
  )
}

interface MemberRowProps {
  member: MemberView
  canManage: boolean
  onChangeRole(memberId: string, role: WorkspaceRole): void
  onRemove(memberId: string): void
}

function MemberRow({ member, canManage, onChangeRole, onRemove }: MemberRowProps) {
  const pending = member.acceptedAt == null
  const label = member.name ?? member.email ?? 'Unknown'
  const initial = (member.name?.[0] ?? member.email?.[0] ?? '?').toUpperCase()
  const isOwner = member.role === 'owner'
  const editable = canManage && !isOwner && !member.inherited

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[var(--border-default)] py-2 last:border-0">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--bg-input)] text-sm font-semibold text-[var(--text-secondary)]">
          {initial}
        </div>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium text-[var(--text-primary)]">
            <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
            {pending && (
              <span className="rounded border border-[var(--border-default)] px-1.5 py-0.5 text-sm font-medium text-[var(--text-muted)]">
                Pending
              </span>
            )}
          </p>
          {member.name && member.email && (
            <p className="text-sm text-[var(--text-muted)] [overflow-wrap:anywhere]">{member.email}</p>
          )}
        </div>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {isOwner ? (
          <span className="rounded border border-[var(--border-default)] px-2 py-0.5 text-sm text-[var(--text-secondary)]">
            {member.inherited ? 'Org Admin' : 'Owner'}
          </span>
        ) : editable ? (
          <>
            <RoleSelect
              value={member.role}
              ariaLabel={`Role for ${label}`}
              onChange={(role) => onChangeRole(member.id, role)}
            />
            <button
              type="button"
              aria-label={`Remove ${label}`}
              onClick={() => onRemove(member.id)}
              className="rounded px-2 py-1 text-sm text-[var(--text-danger)] hover:bg-[var(--border-default)]"
            >
              Remove
            </button>
          </>
        ) : (
          <span className="rounded border border-[var(--border-default)] px-2 py-0.5 text-sm capitalize text-[var(--text-secondary)]">
            {member.role}
          </span>
        )}
      </div>
    </div>
  )
}
