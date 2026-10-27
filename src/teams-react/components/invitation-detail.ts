/** The line under an invitation's address, shared by `InvitationsPanel` and the settings `InvitationsSection`. */

import type { InvitationDelivery } from '../../teams/invitations'
import type { InvitationView } from '../contracts'
import { ROLE_CAPABILITY } from './RoleSelect'

function shortDate(value: Date | number | string): string {
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * The line under the address: what the invitee can do, then only what is true
 * of this invitation now. Every status says itself in words, so a past
 * invitation reads as joined, expired or revoked without a badge. A link-only
 * invitation never mentions email.
 */
export function invitationDetail(invitation: InvitationView, delivery: InvitationDelivery = 'email'): string {
  const role = ROLE_CAPABILITY[invitation.permissions]
  switch (invitation.status) {
    case 'accepted':
      return invitation.acceptedAt ? `${role} · joined ${shortDate(invitation.acceptedAt)}` : `${role} · joined`
    case 'pending': {
      const sent = delivery === 'link' ? null : invitation.emailStatus === 'sent' ? 'email sent' : invitation.emailStatus === 'not_sent' ? 'email not sent yet' : null
      return [role, sent, `expires ${shortDate(invitation.expiresAt)}`].filter(Boolean).join(' · ')
    }
    case 'expired':
      return `${role} · expired ${shortDate(invitation.expiresAt)}`
    case 'revoked':
      return `${role} · revoked`
  }
}
