import type { Meta, StoryObj } from '@storybook/react'
import { HubIntegrationsPanel } from './panel'
import { createHubIntegrationsClient } from './client'
import { useMemo, useState, type ComponentProps } from 'react'

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

const manyProviders = [...providers, ...[
  ['linear', 'Linear', 'Development'], ['figma', 'Figma', 'Design'], ['discord', 'Discord', 'Messaging'],
  ['resend', 'Resend', 'Messaging'], ['airtable', 'Airtable', 'Productivity'], ['asana', 'Asana', 'Productivity'],
].map(([providerId, title, category]) => ({ ...providers[0]!, providerId, title, category }))]
const manyConnections = Array.from({ length: 24 }, (_, index) => ({
  ...connection, id: `fixture-account-${index}`, providerId: providers[index % providers.length]!.providerId,
  displayName: providers[index % providers.length]!.title,
  accountDisplay: index === 0 ? 'Aleksandra Wiśniewska-Kowalczyk · northwind-communications@example.com' : `Example workspace ${index + 1}`,
  health: index === 2 ? 'unhealthy' : 'healthy',
}))

function ManyAccountsFixture(args: ComponentProps<typeof HubIntegrationsPanel>) {
  const [enabled, setEnabled] = useState(() => new Set(['fixture-account-0', 'fixture-account-2']))
  const client = useMemo(() => createHubIntegrationsClient(async ({ path }) => {
    const url = new URL(path, 'https://fixture.invalid')
    if (url.pathname.endsWith('/providers')) return Response.json({ providers: manyProviders })
    if (url.pathname.endsWith('/connections')) return Response.json({ connections: manyConnections })
    if (url.pathname.endsWith('/actions')) return Response.json({ tools: [] })
    if (url.pathname.endsWith('/policies')) return Response.json({ policies: [] })
    return Response.json({ error: 'Read-only story' }, { status: 403 })
  }), [])
  return <HubIntegrationsPanel {...args} client={client} accounts={{
    title: 'Accounts', description: 'Enable accounts for this agent. Manage changes the connected account wherever it is used.',
    getStatus: account => ({ label: enabled.has(account.id) ? 'Enabled for this agent' : 'Not enabled', tone: enabled.has(account.id) ? 'success' : 'neutral' }),
    getPrimaryAction: account => ({ id: 'agent-access', label: enabled.has(account.id) ? 'Remove from agent' : 'Enable for this agent', onSelect: () => setEnabled(previous => {
      const next = new Set(previous); if (next.has(account.id)) next.delete(account.id); else next.add(account.id); return next
    }) }),
  }} />
}
export const ManyAccounts: Story = { args: { layout: 'tiles' }, render: args => <ManyAccountsFixture {...args} /> }
