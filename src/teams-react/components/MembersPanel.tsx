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

import { useState } from 'react'
import type { WorkspaceRole } from '../../teams/roles'
import { hasWorkspaceRole } from '../../teams/roles'
import type { MemberView, MembersPanelProps } from '../contracts'

const ASSIGNABLE: { value: WorkspaceRole; label: string }[] = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'editor', label: 'Editor' },
  { value: 'admin', label: 'Admin' },
]

export function MembersPanel({
  members,
  currentRole,
  onInvite,
  onChangeRole,
  onRemove,
  onNotice,
  showInviteForm = true,
}: MembersPanelProps) {
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>('editor')
  const [inviting, setInviting] = useState(false)

  const canManage = hasWorkspaceRole(currentRole, 'admin')

  function notify(kind: 'success' | 'error', message: string) {
    onNotice?.({ kind, message })
  }

  async function submitInvite() {
    const email = inviteEmail.trim()
    if (!email || inviting) return
    setInviting(true)
    try {
      const result = await onInvite({ email, role: inviteRole })
      if (result && 'inviteUrl' in result && result.inviteUrl) {
        notify('success', `Invite link ready for ${email}`)
      } else {
        notify('success', `Invited ${email}`)
      }
      setInviteEmail('')
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to invite')
    } finally {
      setInviting(false)
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
        <div className="flex flex-col gap-1.5 border-t border-[var(--border-default)] pt-3">
          <label className="text-xs font-medium text-[var(--text-muted)]">Invite member</label>
          <div className="flex gap-2">
            <input
              type="email"
              placeholder="Email address"
              value={inviteEmail}
              aria-label="Invite email address"
              onChange={(event) => setInviteEmail(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void submitInvite() }}
              className="flex-1 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
            <select
              value={inviteRole}
              aria-label="Invite role"
              onChange={(event) => setInviteRole(event.target.value as WorkspaceRole)}
              className="rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-2 py-1.5 text-xs text-[var(--text-secondary)]"
            >
              {ASSIGNABLE.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void submitInvite()}
              disabled={inviting || !inviteEmail.trim()}
              className="rounded bg-[var(--brand-primary)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {inviting ? 'Inviting…' : 'Invite'}
            </button>
          </div>
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
    <div className="flex items-center justify-between border-b border-[var(--border-default)] py-2 last:border-0">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--bg-input)] text-xs font-bold text-[var(--text-secondary)]">
          {initial}
        </div>
        <div>
          <p className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
            {label}
            {pending && (
              <span className="rounded border border-[var(--border-default)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--text-muted)]">
                Pending
              </span>
            )}
          </p>
          {member.name && member.email && (
            <p className="text-xs text-[var(--text-muted)]">{member.email}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {isOwner ? (
          <span className="rounded border border-[var(--border-default)] px-2 py-0.5 text-xs text-[var(--text-secondary)]">
            {member.inherited ? 'Org Admin' : 'Owner'}
          </span>
        ) : editable ? (
          <>
            <select
              value={member.role}
              aria-label={`Role for ${label}`}
              onChange={(event) => onChangeRole(member.id, event.target.value as WorkspaceRole)}
              className="rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-2 py-1 text-xs text-[var(--text-secondary)]"
            >
              {ASSIGNABLE.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <button
              type="button"
              aria-label={`Remove ${label}`}
              onClick={() => onRemove(member.id)}
              className="rounded px-2 py-1 text-xs text-[var(--text-danger)] hover:bg-[var(--border-default)]"
            >
              Remove
            </button>
          </>
        ) : (
          <span className="rounded border border-[var(--border-default)] px-2 py-0.5 text-xs capitalize text-[var(--text-secondary)]">
            {member.role}
          </span>
        )}
      </div>
    </div>
  )
}
