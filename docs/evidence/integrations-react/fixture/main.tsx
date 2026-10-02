import { createRoot } from 'react-dom/client'
import { HubIntegrationsPanel, createHubIntegrationsClient, type HubIntegrationCapabilities, type HubIntegrationsIdentity } from '@tangle-network/agent-app/integrations-react'
import { IntegrationsCatalog } from '@tangle-network/sandbox-ui/integrations'
import '@tangle-network/sandbox-ui/styles'
import './preview.css'

const identity: HubIntegrationsIdentity = { userId: 'proof-user', sessionId: 'proof-session', workspaceId: 'proof-workspace' }
const can: HubIntegrationCapabilities = () => true
const provider = { providerId: 'cloudbeds', title: 'Cloudbeds', authKind: 'api_key', authHint: 'Enter your account API key', category: 'Travel', scopes: [], capabilityCount: 2, native: false, configured: true }
const connections = [
  { id: 'hotel-a', providerId: 'cloudbeds', displayName: 'Cloudbeds', accountDisplay: 'Hotel A', providerAccountId: 'hotel_a', scopes: [], status: 'active', health: 'healthy', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', lastUsedAt: null },
  { id: 'hotel-b', providerId: 'cloudbeds', displayName: 'Cloudbeds', accountDisplay: 'Hotel B', providerAccountId: 'hotel_b', scopes: [], status: 'active', health: 'healthy', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', lastUsedAt: null },
]
const tools = [
  { path: 'cloudbeds.rooms.update', providerId: 'cloudbeds', title: 'Update a room', risk: 'write' },
  { path: 'cloudbeds.rooms.list', providerId: 'cloudbeds', title: 'List rooms', risk: 'read' },
]
const policies: Record<string, Array<{ id: string; providerId: string; connectionId: string; actionPath: string; decision: 'allow' | 'ask' | 'deny'; createdAt: string; updatedAt: string }>> = JSON.parse(sessionStorage.getItem('hub-proof-policies') ?? '{}')
const calls: string[] = []
Object.assign(window, { __hubProof: { calls, policies } })
const client = createHubIntegrationsClient(async ({ identity: expected, path, init }) => {
  if (expected.userId !== identity.userId || expected.sessionId !== identity.sessionId || expected.workspaceId !== identity.workspaceId) return Response.json({ code: 'HUB_FORBIDDEN' }, { status: 403 })
  const url = new URL(path, window.location.origin)
  const method = init.method ?? 'GET'
  calls.push(`${method} ${url.pathname}${url.search}`)
  const body = init.body ? JSON.parse(String(init.body)) : {}
  if (url.pathname.endsWith('/providers') && method === 'GET') return Response.json({ providers: [provider] })
  if (url.pathname.endsWith('/connections') && method === 'GET') return Response.json({ connections })
  if (url.pathname.endsWith('/actions') && method === 'GET') return Response.json({ tools })
  if (url.pathname.endsWith('/policies') && method === 'GET') return Response.json({ policies: policies[url.searchParams.get('connectionId') ?? ''] ?? [] })
  if (url.pathname.endsWith('/policies') && method === 'PUT') {
    const policy = { id: 'policy-1', providerId: 'cloudbeds', connectionId: body.connectionId, actionPath: body.actionPath, decision: body.decision, createdAt: 'now', updatedAt: 'now' }
    policies[body.connectionId] = [policy]
    sessionStorage.setItem('hub-proof-policies', JSON.stringify(policies))
    return Response.json({ policy })
  }
  if (url.pathname.endsWith('/policies') && method === 'DELETE') {
    policies[body.connectionId] = []
    sessionStorage.setItem('hub-proof-policies', JSON.stringify(policies))
    return Response.json({ connectionId: body.connectionId, actionPath: body.actionPath, deleted: true })
  }
  if (url.pathname.endsWith('/connect-key') && method === 'POST') {
    const connection = { ...connections[0], id: 'hotel-c', accountDisplay: 'Hotel C', providerAccountId: 'hotel_c', updatedAt: '2026-10-02T00:00:00Z' }
    connections.push(connection)
    return Response.json({ connection })
  }
  if (url.pathname.endsWith('/health') && method === 'POST') return Response.json({ connection: connections.find(item => item.id === url.pathname.split('/').at(-2)), health: { status: 'healthy', checkedAt: 'now' } })
  if (method === 'DELETE' && url.pathname.includes('/connections/')) {
    const connection = connections.find(item => item.id === url.pathname.split('/').at(-1))
    if (connection) { connection.status = 'revoked'; return Response.json({ connection }) }
  }
  return Response.json({ code: 'HUB_INVALID_INPUT' }, { status: 400 })
})

function App() {
  const before = window.location.pathname === '/before'
  return <div className="proof-shell">
    <header className="proof-head"><div><p className="eyebrow">Installed package consumer · fixture account</p><h1>{before ? 'Existing controlled catalog reference' : 'Hub connections'}</h1><p>Manage the accounts and action permissions available to this workspace.</p></div><nav><a href="/before">Reference</a><a href="/after">Controller</a></nav></header>
    {before ? <IntegrationsCatalog rows={[{ kind: 'provider', providerId: 'cloudbeds', title: 'Cloudbeds', category: 'Travel', authKind: 'api_key', canConnect: false, selectedConnectionId: null, connections: [{ id: 'hotel-a', accountDisplay: 'Hotel A', statusLabel: 'Connected', statusTone: 'success', capabilities: { manage: false, disconnect: false, test: false, editPermissions: false, resetPermissions: false } }, { id: 'hotel-b', accountDisplay: 'Hotel B', statusLabel: 'Connected', statusTone: 'success', capabilities: { manage: false, disconnect: false, test: false, editPermissions: false, resetPermissions: false } }] }]} query="" onQueryChange={() => {}} categoryFilter="" onCategoryFilterChange={() => {}} sort="featured" onSortChange={() => {}} onSelectConnection={() => {}} title="Integrations" />
      : <HubIntegrationsPanel identity={identity} client={client} can={can} callbackPath="/integrations/callback" title="Integrations" />}
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
