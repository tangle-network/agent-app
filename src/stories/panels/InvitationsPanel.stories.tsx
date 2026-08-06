import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { InvitationsPanel } from '../../teams-react'
import type { InvitationsPanelProps, InvitationView } from '../../teams-react'
import { INVITATIONS } from './fixtures'

const meta: Meta<typeof InvitationsPanel> = {
  title: 'Teams/InvitationsPanel',
  component: InvitationsPanel,
}

export default meta
type Story = StoryObj<typeof InvitationsPanel>

function PanelFrame({ children }: { children: React.ReactNode }) {
  return <div className="w-[440px] p-4">{children}</div>
}

const onInvite: InvitationsPanelProps['onInvite'] = async (input) => {
  console.log('onInvite', input)
}
const onResend: InvitationsPanelProps['onResend'] = async (input) => {
  console.log('onResend', input)
}
const onRevoke: InvitationsPanelProps['onRevoke'] = async (input) => {
  console.log('onRevoke', input)
}
const onCopy: InvitationsPanelProps['onCopy'] = (input) => {
  console.log('onCopy', input)
}
const onNotice: InvitationsPanelProps['onNotice'] = (notice) => {
  console.log('onNotice', notice)
}

const baseProps = {
  invitations: INVITATIONS,
  currentRole: 'admin',
  onInvite,
  onResend,
  onRevoke,
  onCopy,
  onNotice,
} satisfies InvitationsPanelProps

export const Populated: Story = {
  name: 'Populated (admin)',
  decorators: [(Story) => <PanelFrame><Story /></PanelFrame>],
  args: { ...baseProps },
}

export const ReadOnly: Story = {
  name: 'Read-only (viewer)',
  decorators: [(Story) => <PanelFrame><Story /></PanelFrame>],
  args: {
    ...baseProps,
    currentRole: 'viewer',
  },
}

export const Empty: Story = {
  decorators: [(Story) => <PanelFrame><Story /></PanelFrame>],
  args: {
    ...baseProps,
    invitations: [],
  },
}

/** Fully wired: invite appends a pending row, resend flips the email status
 *  to sent, revoke moves the row to the revoked state. */
export const Interactive: Story = {
  decorators: [(Story) => <PanelFrame><Story /></PanelFrame>],
  render: function InteractiveInvitations() {
    const [invitations, setInvitations] = useState<InvitationView[]>(INVITATIONS)
    return (
      <InvitationsPanel
        invitations={invitations}
        currentRole="admin"
        onCopy={onCopy}
        onNotice={onNotice}
        onInvite={async (input) => {
          console.log('onInvite', input)
          setInvitations((prev) => [
            {
              id: `inv-${input.email}`,
              email: input.email,
              // The invite form only offers assignable roles (never owner).
              permissions: input.role === 'owner' ? 'admin' : input.role,
              status: 'pending',
              emailStatus: 'sent',
              expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
              inviteUrl: `https://app.tangle.example/invite/inv_${input.email}`,
            },
            ...prev,
          ])
        }}
        onResend={async (input) => {
          console.log('onResend', input)
          setInvitations((prev) =>
            prev.map((invitation) =>
              invitation.id === input.invitationId ? { ...invitation, emailStatus: 'sent' } : invitation,
            ),
          )
        }}
        onRevoke={async (input) => {
          console.log('onRevoke', input)
          setInvitations((prev) =>
            prev.map((invitation) =>
              invitation.id === input.invitationId ? { ...invitation, status: 'revoked' } : invitation,
            ),
          )
        }}
      />
    )
  },
}

/** Lifecycle badges, delivery badges, and the role gate side by side. */
export const AllStates: Story = {
  name: 'All states',
  render: () => (
    <div className="grid gap-8 p-4 lg:grid-cols-2">
      {(
        [
          ['Admin — full history + actions', <InvitationsPanel key="admin" {...baseProps} />],
          ['Viewer — read-only', <InvitationsPanel key="viewer" {...baseProps} currentRole="viewer" />],
          ['Empty history', <InvitationsPanel key="empty" {...baseProps} invitations={[]} />],
        ] as const
      ).map(([label, panel]) => (
        <div key={label} className="w-[440px]">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
          <div className="rounded-lg border border-border p-4">{panel}</div>
        </div>
      ))}
    </div>
  ),
}
