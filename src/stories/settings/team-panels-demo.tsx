/**
 * The teams panels that Tax, Legal and GTM render today, each in a card the
 * way those pages draw them, so the story and the browser proof can check
 * that the role picker, Remove and Invite stay inside the card at phone width.
 * As `admin` the viewer is Amir, an admin whose own row offers no role change
 * or removal.
 */

import { InvitationsPanel, MembersPanel } from '../../teams-react'
import { INVITATIONS, MEMBERS } from '../panels/fixtures'

const done = async () => undefined

const VIEWERS = {
  owner: { currentRole: 'owner', currentUserId: 'usr-dana' },
  admin: { currentRole: 'admin', currentUserId: 'usr-amir' },
} as const

export function TeamPanelsDemo({ viewer = 'owner' }: { viewer?: keyof typeof VIEWERS }) {
  const { currentRole, currentUserId } = VIEWERS[viewer]
  return (
    <main className="mx-auto grid max-w-2xl gap-4 p-4">
      <div data-team-panel="members" className="rounded-lg border border-border bg-card p-4">
        <MembersPanel members={MEMBERS} currentRole={currentRole} currentUserId={currentUserId} onInvite={done} onChangeRole={done} onRemove={done} />
      </div>
      <div data-team-panel="invitations" className="rounded-lg border border-border bg-card p-4">
        <InvitationsPanel invitations={INVITATIONS} currentRole={currentRole} onInvite={done} onResend={done} onRevoke={done} />
      </div>
    </main>
  )
}
