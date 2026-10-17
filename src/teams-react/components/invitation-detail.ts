/** The line under an invitation's address, shared by `InvitationsPanel` and the settings `InvitationsSection`. */

import type { InvitationView } from '../contracts'
import { ROLE_CAPABILITY } from './RoleSelect'

function shortDate(value: Date | number | string): string {
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** The line under the address: what the invitee can do, then only what is true of this invitation now. */
export function invitationDetail(invitation: InvitationView): string {
  const role = ROLE_CAPABILITY[invitation.permissions]
  switch (invitation.status) {
    case 'accepted':
      return invitation.acceptedAt ? `${role} · joined ${shortDate(invitation.acceptedAt)}` : role
    case 'pending': {
      const delivery = invitation.emailStatus === 'sent' ? 'email sent' : invitation.emailStatus === 'not_sent' ? 'email not sent yet' : null
      return [role, delivery, `expires ${shortDate(invitation.expiresAt)}`].filter(Boolean).join(' · ')
    }
    case 'expired':
      return `${role} · expired ${shortDate(invitation.expiresAt)}`
    case 'revoked':
      return role
  }
}
