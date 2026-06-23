/**
 * Email-invitation panel: invite by email + role, and a history of every
 * invitation (pending / accepted / expired / revoked) with its email-delivery
 * status. Pending rows expose copy-link / resend / revoke. Fully callback-driven
 * — the host supplies the data and the async `onInvite` / `onResend` / `onRevoke`
 * callbacks (backed by `./teams/invitations-api`), so this imports no app router,
 * fetch client, or toast. Styled with the shipped Tangle Quiet tokens (`var(--*)`).
 *
 * Mount alongside a list-only `MembersPanel` (`showInviteForm={false}`): the
 * members panel shows accepted members, this owns the invite flow + pending list.
 */

import { useState } from 'react'
import type { WorkspaceRole } from '../../teams/roles'
import { hasWorkspaceRole } from '../../teams/roles'
import type { InvitationView, InvitationsPanelProps } from '../contracts'

const ASSIGNABLE: { value: WorkspaceRole; label: string }[] = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'editor', label: 'Editor' },
  { value: 'admin', label: 'Admin' },
]

export function InvitationsPanel({
  invitations,
  currentRole,
  onInvite,
  onResend,
  onRevoke,
  onCopy,
  onNotice,
}: InvitationsPanelProps) {
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>('editor')
  const [inviting, setInviting] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const canManage = hasWorkspaceRole(currentRole, 'admin')

  function notify(kind: 'success' | 'error', message: string) {
    onNotice?.({ kind, message })
  }

  async function submitInvite() {
    const email = inviteEmail.trim()
    if (!email || inviting) return
    setInviting(true)
    try {
      await onInvite({ email, role: inviteRole })
      notify('success', `Invitation sent to ${email}`)
      setInviteEmail('')
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to invite')
    } finally {
      setInviting(false)
    }
  }

  async function copyLink(inviteUrl: string) {
    try {
      if (onCopy) await onCopy({ inviteUrl })
      else await navigator.clipboard.writeText(inviteUrl)
      notify('success', 'Invite link copied')
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to copy link')
    }
  }

  async function resend(invitationId: string) {
    setBusyId(invitationId)
    try {
      await onResend({ invitationId })
      notify('success', 'Invitation resent')
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to resend invitation')
    } finally {
      setBusyId(null)
    }
  }

  async function revoke(invitationId: string) {
    setBusyId(invitationId)
    try {
      await onRevoke({ invitationId })
      notify('success', 'Invitation revoked')
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to revoke invitation')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="flex flex-col gap-4">
      {canManage && (
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-[var(--text-muted)]">Invite by email</label>
          <div className="flex gap-2">
            <input
              type="email"
              placeholder="colleague@example.com"
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

      <div className="flex flex-col gap-2 border-t border-[var(--border-default)] pt-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold text-[var(--text-primary)]">Invitation history</h4>
          <span className="text-xs text-[var(--text-muted)]">{invitations.length} total</span>
        </div>
        {invitations.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No invitations yet.</p>
        ) : (
          invitations.map((invitation) => (
            <InvitationRow
              key={invitation.id}
              invitation={invitation}
              canManage={canManage}
              busy={busyId === invitation.id}
              onCopy={() => void copyLink(invitation.inviteUrl)}
              onResend={() => void resend(invitation.id)}
              onRevoke={() => void revoke(invitation.id)}
            />
          ))
        )}
      </div>
    </section>
  )
}

interface InvitationRowProps {
  invitation: InvitationView
  canManage: boolean
  busy: boolean
  onCopy(): void
  onResend(): void
  onRevoke(): void
}

function InvitationRow({ invitation, canManage, busy, onCopy, onResend, onRevoke }: InvitationRowProps) {
  const isPending = invitation.status === 'pending'
  const emailFailed = invitation.emailStatus === 'failed'
  const expiry = new Date(invitation.expiresAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  return (
    <div className="rounded-lg border border-[var(--border-default)] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-[var(--text-primary)]">{invitation.email}</p>
          <p className="text-xs capitalize text-[var(--text-muted)]">
            {invitation.permissions} · expires {expiry}
          </p>
          {emailFailed && (
            <p className="mt-1 text-xs text-[var(--text-danger)]">Email was not sent — copy the link to share it.</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded border border-[var(--border-default)] px-2 py-0.5 text-[10px] uppercase text-[var(--text-secondary)]">
            {invitation.status}
          </span>
          <span
            className={`rounded border border-[var(--border-default)] px-2 py-0.5 text-[10px] uppercase ${
              emailFailed ? 'text-[var(--text-danger)]' : 'text-[var(--text-muted)]'
            }`}
          >
            {invitation.emailStatus.replace('_', ' ')}
          </span>
        </div>
      </div>
      {canManage && isPending && (
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCopy}
            disabled={busy}
            className="rounded border border-[var(--border-default)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            Copy link
          </button>
          <button
            type="button"
            onClick={onResend}
            disabled={busy}
            className="rounded border border-[var(--border-default)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Resend'}
          </button>
          <button
            type="button"
            onClick={onRevoke}
            disabled={busy}
            className="rounded px-2 py-1 text-xs text-[var(--text-danger)] hover:bg-[var(--border-default)] disabled:opacity-50"
          >
            Revoke
          </button>
        </div>
      )}
    </div>
  )
}
