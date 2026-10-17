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

import { Button } from '@tangle-network/ui/primitives'
import { useState } from 'react'
import { hasWorkspaceRole, type WorkspaceRole } from '../../teams/roles'
import type { InvitationView, InvitationsPanelProps } from '../contracts'
import { invitationDetail } from './invitation-detail'
import { InviteForm } from './InviteForm'

const BADGE_BASE = 'inline-flex items-center rounded border px-2 py-0.5 text-sm font-medium'

// One badge per invitation, for where it stands: green = joined, amber =
// waiting on the invitee, red = withdrawn, muted = lapsed. Email delivery is a
// detail of a pending invitation, so it is said in words on the line below,
// never as a second badge beside "Joined".
const STATUS: Record<InvitationView['status'], { label: string; tone: string }> = {
  accepted: { label: 'Joined', tone: 'border-[var(--surface-success-border)] bg-[var(--surface-success-bg)] text-[var(--surface-success-text)]' },
  pending: { label: 'Pending', tone: 'border-[var(--surface-warning-border)] bg-[var(--surface-warning-bg)] text-[var(--surface-warning-text)]' },
  revoked: { label: 'Revoked', tone: 'border-[var(--surface-danger-border)] bg-[var(--surface-danger-bg)] text-[var(--surface-danger-text)]' },
  expired: { label: 'Expired', tone: 'border-[var(--border-default)] text-[var(--text-muted)]' },
}

export function InvitationsPanel({
  invitations,
  currentRole,
  onInvite,
  onResend,
  onRevoke,
  onCopy,
  onNotice,
}: InvitationsPanelProps) {
  const [busyId, setBusyId] = useState<string | null>(null)

  const canManage = hasWorkspaceRole(currentRole, 'admin')

  function notify(kind: 'success' | 'error', message: string) {
    onNotice?.({ kind, message })
  }

  async function invite(input: { email: string; role: WorkspaceRole }): Promise<boolean> {
    try {
      await onInvite(input)
      notify('success', `Invitation sent to ${input.email}`)
      return true
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to invite')
      return false
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
      {canManage && <InviteForm label="Invite by email" placeholder="colleague@example.com" onInvite={invite} />}

      <div className="flex flex-col gap-2 border-t border-[var(--border-default)] pt-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-[var(--text-primary)]">Invitation history</h4>
          <span className="text-sm text-[var(--text-muted)]">{invitations.length} total</span>
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
  const status = STATUS[invitation.status]

  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-input)] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-[var(--text-primary)]" title={invitation.email}>{invitation.email}</p>
          <p className="text-sm text-[var(--text-muted)]">{invitationDetail(invitation)}</p>
          {isPending && invitation.emailStatus === 'failed' && (
            <p className="mt-1 text-sm text-[var(--surface-danger-text)]">The email was not delivered. Copy the link and send it yourself.</p>
          )}
        </div>
        <span className={`${BADGE_BASE} ${status.tone} shrink-0`}>{status.label}</span>
      </div>
      {canManage && isPending && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCopy} disabled={busy}>Copy link</Button>
          <Button type="button" variant="outline" onClick={onResend} disabled={busy}>{busy ? 'Working…' : 'Resend'}</Button>
          <Button type="button" variant="destructive-outline" onClick={onRevoke} disabled={busy}>Revoke</Button>
        </div>
      )}
    </div>
  )
}
