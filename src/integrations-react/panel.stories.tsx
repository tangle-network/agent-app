import type { Meta, StoryObj } from '@storybook/react'
import { HubIntegrationsPanel } from './panel'
import { createHubIntegrationsClient } from './client'

const providers = [
  ['github', 'GitHub', 'Development'], ['telegram', 'Telegram', 'Messaging'],
  ['slack', 'Slack', 'Messaging'], ['notion', 'Notion', 'Productivity'],
  ['google-drive', 'Google Drive', 'Productivity'], ['stripe', 'Stripe', 'Payments'],
].map(([providerId, title, category]) => ({ providerId, title, category, description: `Use ${title} with this agent.`, authKind: 'api_key', scopes: [], capabilityCount: 2, native: false, configured: true }))
const connection = {
  id: 'fixture-github', providerId: 'github', displayName: 'GitHub', accountDisplay: 'Example team',
  providerAccountId: 'fixture-team', scopes: [], status: 'active', health: 'healthy',
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', lastUsedAt: null,
}
const client = createHubIntegrationsClient(async ({ path }) => {
  const url = new URL(path, 'https://fixture.invalid')
  if (url.pathname.endsWith('/providers')) return Response.json({ providers })
  if (url.pathname.endsWith('/connections')) return Response.json({ connections: [connection] })
  if (url.pathname.endsWith('/actions')) return Response.json({ tools: [] })
  if (url.pathname.endsWith('/policies')) return Response.json({ policies: [] })
  return Response.json({ error: 'Read-only story' }, { status: 403 })
})

const meta: Meta<typeof HubIntegrationsPanel> = {
  title: 'Integrations/Hub catalog', component: HubIntegrationsPanel,
  parameters: { layout: 'padded' },
  args: {
    identity: { userId: 'fixture-user', sessionId: 'fixture-session', workspaceId: 'fixture-workspace' },
    client, callbackPath: '/callback', title: 'Integrations',
    can: intent => intent.operation !== 'connection.revoke',
    getConnectionContext: () => 'Enabled for this agent',
  },
}
export default meta
type Story = StoryObj<typeof HubIntegrationsPanel>
export const Cards: Story = {}
export const Tiles: Story = { args: { layout: 'tiles' } }
export const AgentAccounts: Story = { args: { layout: 'tiles', accounts: {
  title: 'Connected accounts', getStatus: () => ({ label: 'Enabled for this agent', tone: 'success' }),
} } }
