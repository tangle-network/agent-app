import type { Meta, StoryObj } from '@storybook/react'
import { InviteAcceptPage } from '../../teams-react'
import type { InviteAcceptPageProps } from '../../teams-react'
import {
  INVITE_EMAIL_MISMATCH,
  INVITE_NEEDS_VERIFICATION,
  INVITE_READY,
  INVITE_SIGNED_OUT,
} from './fixtures'

const meta: Meta<typeof InviteAcceptPage> = {
  title: 'Teams/InviteAcceptPage',
  component: InviteAcceptPage,
  parameters: { layout: 'fullscreen' },
  decorators: [
    // The `/invite/:token` route backdrop — the page shell self-centers at max-w-sm.
    (Story) => (
      <div className="min-h-screen bg-background px-4 py-16">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof InviteAcceptPage>

const onAccept: InviteAcceptPageProps['onAccept'] = async () => {
  console.log('onAccept')
  return { workspaceId: 'ws-acme' }
}
const onNavigate: InviteAcceptPageProps['onNavigate'] = (target) => {
  console.log('onNavigate', target)
}
const onResendVerification: InviteAcceptPageProps['onResendVerification'] = async () => {
  console.log('onResendVerification')
}

export const SignedOut: Story = {
  name: 'Signed out',
  args: { details: INVITE_SIGNED_OUT, onAccept, onNavigate },
}

export const ReadyToAccept: Story = {
  name: 'Ready to accept',
  args: { details: INVITE_READY, onAccept, onNavigate },
}

export const EmailMismatch: Story = {
  name: 'Email mismatch',
  args: { details: INVITE_EMAIL_MISMATCH, onAccept, onNavigate },
}

export const NeedsVerification: Story = {
  name: 'Needs email verification',
  args: { details: INVITE_NEEDS_VERIFICATION, onAccept, onNavigate, onResendVerification },
}

export const Invalid: Story = {
  args: { details: { status: 'invalid' }, onAccept, onNavigate },
}

export const AlreadyAccepted: Story = {
  name: 'Already accepted',
  args: { details: { status: 'already-accepted' }, onAccept, onNavigate },
}

export const Expired: Story = {
  args: { details: { status: 'expired' }, onAccept, onNavigate },
}

export const Revoked: Story = {
  args: { details: { status: 'revoked' }, onAccept, onNavigate },
}

/** Click through the accept: pending → Accepting… → Welcome. */
export const AcceptFlow: Story = {
  name: 'Accept flow (interactive)',
  args: {
    details: INVITE_READY,
    onNavigate,
    onAccept: async () => {
      await new Promise((resolve) => setTimeout(resolve, 800))
      console.log('onAccept')
      return { workspaceId: 'ws-acme' }
    },
  },
}

/** Every `/invite/:token` branch on one canvas. */
export const AllStates: Story = {
  name: 'All states',
  render: () => (
    <div className="grid gap-8 lg:grid-cols-2 2xl:grid-cols-3">
      {(
        [
          ['Signed out', INVITE_SIGNED_OUT],
          ['Ready to accept', INVITE_READY],
          ['Email mismatch', INVITE_EMAIL_MISMATCH],
          ['Needs verification', INVITE_NEEDS_VERIFICATION],
          ['Invalid', { status: 'invalid' }],
          ['Already accepted', { status: 'already-accepted' }],
          ['Expired', { status: 'expired' }],
          ['Revoked', { status: 'revoked' }],
        ] as const
      ).map(([label, details]) => (
        <div key={label}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
          <div className="rounded-lg border border-border bg-card p-6">
            <InviteAcceptPage
              details={details}
              onAccept={onAccept}
              onNavigate={onNavigate}
              onResendVerification={onResendVerification}
            />
          </div>
        </div>
      ))}
    </div>
  ),
}
