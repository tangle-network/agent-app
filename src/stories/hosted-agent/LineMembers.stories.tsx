import type { Meta, StoryObj } from '@storybook/react'
import type { LineMember } from '@tangle-network/sandbox'
import { useMemo } from 'react'
import { userEvent, within } from 'storybook/test'
import { LineMembers } from '../../hosted-agent/react'
import { createMembersClient, createMembersRefreshFailureClient, memberRoles, members } from './fixtures'

const meta: Meta<typeof LineMembers> = {
  title: 'Hosted agent/Lines/Members',
  component: LineMembers,
  parameters: { layout: 'padded' },
  decorators: [(Story) => <div style={{ maxWidth: 760, padding: 16 }}><Story /></div>],
}

export default meta
type Story = StoryObj<typeof LineMembers>

const base = { lineId: 'ln_email', scopeKey: 'storybook-members', roles: memberRoles, canManage: true }

function MembersFixture({ initial, failRefreshAfterMutation = false }: { initial: LineMember[]; failRefreshAfterMutation?: boolean }) {
  const client = useMemo(() => failRefreshAfterMutation
    ? createMembersRefreshFailureClient(initial) : createMembersClient(initial), [initial, failRefreshAfterMutation])
  return <LineMembers {...base} client={client} />
}

export const InvitedAndStopped: Story = {
  render: () => <MembersFixture initial={members} />,
}

export const Empty: Story = {
  render: () => <MembersFixture initial={[]} />,
}

export const RefreshAfterInviteError: Story = {
  render: () => <MembersFixture initial={members} failRefreshAfterMutation />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(await canvas.findByLabelText('Phone number or email'), 'new@example.com')
    await userEvent.click(await canvas.findByRole('button', { name: 'Invite member' }))
    await canvas.findByText('The updated member list could not be loaded.')
  },
}

export const Loading: Story = {
  args: { ...base, client: { list: () => new Promise(() => {}), add: async () => {}, update: async () => {}, remove: async () => {} } },
}

export const LoadError: Story = {
  args: {
    ...base,
    client: { list: async () => { throw new Error('Members could not be loaded.') }, add: async () => {}, update: async () => {}, remove: async () => {} },
  },
}

function InteractiveMembers() {
  return <MembersFixture initial={members} />
}

export const InteractiveDark: Story = {
  name: 'Interactive · dark',
  globals: { agentTheme: 'agent-dark' },
  render: () => <InteractiveMembers />,
}

export const InteractiveLight: Story = {
  name: 'Interactive · light',
  globals: { agentTheme: 'agent-light' },
  render: () => <InteractiveMembers />,
}
