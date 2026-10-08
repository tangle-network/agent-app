// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { HubClient, type HubConnection, type HubPolicy, type HubProvider, type HubTool } from '@tangle-network/hub-sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHubSettingsRoutes } from '../platform'
import { HubConnectCallbackPage } from './callback'
import { createHubIntegrationsClient, type HubIntegrationsClient, type HubIntegrationsIdentity } from './client'
import { HubIntegrationsPanel } from './panel'
import { connectWithPopup, HUB_CONNECTED_MESSAGE_TYPE, POPUP_TIMEOUT_MS } from './popup'
import { useHubIntegrations } from './use-hub-integrations'

const identity: HubIntegrationsIdentity = { userId: 'user_1', sessionId: 'session_1', workspaceId: 'workspace_1' }
const other: HubIntegrationsIdentity = { userId: 'user_1', sessionId: 'session_2', workspaceId: 'workspace_2' }
const provider: HubProvider = {
  providerId: 'cloudbeds', title: 'Cloudbeds', authKind: 'api_key', authHint: 'Paste an account key',
  category: 'Travel', scopes: [], capabilityCount: 1, native: false, configured: true,
}
const connection: HubConnection = {
  id: 'conn_1', providerId: 'cloudbeds', displayName: 'Cloudbeds', accountDisplay: 'Hotel A',
  providerAccountId: 'hotel_a', scopes: [], status: 'active', health: 'healthy',
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', lastUsedAt: null,
}
const tool: HubTool = { path: 'cloudbeds.rooms.update', providerId: 'cloudbeds', title: 'Update a room', risk: 'write' }
const allow = () => true

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  return { promise, resolve }
}

function fixture() {
  let rows = [connection]
  let policies: HubPolicy[] = []
  let failPolicyRead = false
  const seen: Array<{ path: string; method: string; body?: unknown }> = []
  const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined
    seen.push({ path: url.pathname, method, body })
    let data: unknown
    if (url.pathname.endsWith('/providers')) data = { providers: [provider], substrateBundled: 1 }
    else if (url.pathname.endsWith('/connections') && method === 'GET') data = { connections: rows }
    else if (url.pathname.endsWith('/tools/search')) data = { tools: [tool] }
    else if (url.pathname.endsWith('/policies') && method === 'GET') {
      if (failPolicyRead) return Response.json({ success: false, error: { code: 'HUB_UNAVAILABLE', message: 'test failure' } }, { status: 503 })
      data = { policies }
    } else if (url.pathname.endsWith('/policies') && method === 'PUT') {
      const value = body as { connectionId: string; actionPath: string; decision: 'allow' | 'ask' | 'deny' }
      const policy: HubPolicy = { id: 'policy_1', providerId: 'cloudbeds', connectionId: value.connectionId, actionPath: value.actionPath, decision: value.decision, createdAt: 'now', updatedAt: 'now' }
      policies = [policy]
      data = { policy }
    } else if (url.pathname.endsWith('/policies') && method === 'DELETE') {
      policies = []
      data = { connectionId: 'conn_1', actionPath: tool.path, deleted: true }
    } else if (url.pathname.endsWith('/connect-key')) {
      rows = [connection]
      data = { connection, reconnected: false }
    } else if (url.pathname.endsWith('/conn_1') && method === 'DELETE') {
      rows = []
      data = { connection: { ...connection, status: 'revoked' } }
    } else if (url.pathname.endsWith('/health')) data = { connection, health: { status: 'healthy', checkedAt: 'now' } }
    else throw new Error(`Unexpected SDK request: ${method} ${url.pathname}`)
    return Response.json({ success: true, data })
  })
  const hub = new HubClient({ baseUrl: 'https://hub.example', apiKey: 'server-only-key', fetch: upstream })
  const authorize = vi.fn(async (request: Request) => {
    return request.headers.get('x-expected-session') === identity.sessionId &&
      request.headers.get('x-expected-workspace') === identity.workspaceId
      ? { authorized: true as const, principal: identity }
      : Response.json({ code: 'HUB_FORBIDDEN' }, { status: 403 })
  })
  const routes = createHubSettingsRoutes({ authorize, resolveClient: async principal => ({ principal, credentialSource: 'caller-account', client: hub }) })
  const client = createHubIntegrationsClient(({ identity: expected, path, init }) => {
    const headers = new Headers(init.headers)
    headers.set('x-expected-session', expected.sessionId)
    headers.set('x-expected-workspace', expected.workspaceId)
    headers.set('x-requested-with', 'XMLHttpRequest')
    return routes.handle(new Request(`https://app.example${path}`, { ...init, headers }))
  })
  return { client, authorize, upstream, seen, setFailPolicyRead: (value: boolean) => { failPolicyRead = value }, setConnections: (value: HubConnection[]) => { rows = value } }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/') })

describe('integrations-react through the finite Hub settings server', () => {
  it('loads provider/account state and reconciles a permission write and reset through real SDK routes', async () => {
    const f = fixture()
    const { result } = renderHook(() => useHubIntegrations({ identity, client: f.client, can: allow, callbackPath: '/integrations/callback' }))
    await waitFor(() => expect(result.current.connections.status).toBe('ready'))
    expect(result.current.rows[0]?.connections).toHaveLength(1)
    act(() => result.current.selectConnection('cloudbeds', 'conn_1'))
    await waitFor(() => expect(result.current.detail.status).toBe('ready'))
    expect(result.current.details?.permissionGroups?.[0]?.rows[0]?.decision).toBeNull()
    await act(async () => { await result.current.setDecision('conn_1', tool.path, 'ask') })
    await waitFor(() => expect(result.current.writeState).toMatchObject({ status: 'succeeded', value: { reconciliation: 'verified' } }))
    await waitFor(() => expect(result.current.details?.permissionGroups?.[0]?.rows[0]?.decision).toBe('ask'))
    await act(async () => { await result.current.resetDecision('conn_1', tool.path) })
    await waitFor(() => expect(result.current.details?.permissionGroups?.[0]?.rows[0]?.decision).toBeNull())
    expect(f.seen.filter(call => call.path.endsWith('/policies') && call.method === 'GET').length).toBeGreaterThanOrEqual(3)
    expect(f.authorize.mock.calls.length).toBeGreaterThanOrEqual(12)
  })

  it('keeps a confirmed write distinct from failed authoritative refresh', async () => {
    const f = fixture()
    const { result } = renderHook(() => useHubIntegrations({ identity, client: f.client, can: allow, callbackPath: '/integrations/callback' }))
    await waitFor(() => expect(result.current.connections.status).toBe('ready'))
    act(() => result.current.selectConnection('cloudbeds', 'conn_1'))
    await waitFor(() => expect(result.current.detail.status).toBe('ready'))
    f.setFailPolicyRead(true)
    await act(async () => { await result.current.setDecision('conn_1', tool.path, 'deny') })
    expect(result.current.writeState).toMatchObject({ status: 'succeeded', value: { reconciliation: 'refresh-failed' } })
    expect(f.seen.some(call => call.method === 'PUT' && call.path.endsWith('/policies'))).toBe(true)
  })

  it('rejects an old workspace identity before resolving a server Hub client', async () => {
    const f = fixture()
    await expect(f.client.connections(other)).rejects.toThrow(/403/)
    expect(f.upstream).not.toHaveBeenCalled()
    expect(f.authorize).toHaveBeenCalledTimes(1)
  })

  it('retains multiple accounts and local detail selection through Back and reload', async () => {
    const f = fixture()
    f.setConnections([connection, { ...connection, id: 'conn_2', accountDisplay: 'Hotel B', providerAccountId: 'hotel_b' }])
    window.history.replaceState(null, '', '/settings')
    const { result, unmount } = renderHook(() => useHubIntegrations({ identity, client: f.client, can: allow, callbackPath: '/integrations/callback' }))
    await waitFor(() => expect(result.current.connections.status).toBe('ready'))
    expect(result.current.rows[0]?.connections.map(account => account.id)).toEqual(['conn_1', 'conn_2'])
    expect(result.current.rows[0]?.selectedConnectionId).toBeNull()
    act(() => result.current.selectConnection('cloudbeds', 'conn_1'))
    expect(window.location.search).toBe('?integration=cloudbeds&connection=conn_1')
    unmount()
    const again = renderHook(() => useHubIntegrations({ identity, client: f.client, can: allow, callbackPath: '/integrations/callback' }))
    await waitFor(() => expect(again.result.current.connection?.id).toBe('conn_1'))
    act(() => { window.history.pushState(null, '', '/settings'); window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(again.result.current.selection.providerId).toBeNull()
  })

  it('renders the published controlled catalog with in-app management', async () => {
    const f = fixture()
    render(<HubIntegrationsPanel identity={identity} client={f.client} can={allow} callbackPath="/integrations/callback" />)
    expect(await screen.findByText('Cloudbeds')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Account for Cloudbeds' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('option', { name: /Hotel A/ }))
    expect(window.location.search).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    await waitFor(() => expect(window.location.search).toBe('?integration=cloudbeds&connection=conn_1'))
    expect(await screen.findByText('Update a room')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect another account' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('keeps host actions on the selected account and clears selection when workspace identity changes', async () => {
    const f = fixture()
    f.setConnections([connection, { ...connection, id: 'conn_2', accountDisplay: 'Hotel B' }])
    const useAccount = vi.fn()
    const getConnectionActions = (account: HubConnection) => [{
      id: 'use', label: 'Use in this workspace', onSelect: () => useAccount(account.id),
    }]
    const props = { client: f.client, can: allow, callbackPath: '/integrations/callback', getConnectionActions,
      getConnectionContext: (account: HubConnection) => account.id === 'conn_1' ? 'In this workspace' : 'Available to this workspace' }
    const view = render(<HubIntegrationsPanel {...props} identity={identity} />)
    await screen.findByRole('combobox', { name: 'Account for Cloudbeds' })
    expect(useAccount).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Account for Cloudbeds' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('option', { name: /Hotel A/ }))
    expect(screen.getByText('In this workspace')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Account for Cloudbeds' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('option', { name: /Hotel B/ }))
    expect(screen.queryByText('In this workspace')).toBeNull()
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions for Cloudbeds' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Use in this workspace' }))
    expect(useAccount).toHaveBeenCalledExactlyOnceWith('conn_2')
    expect(window.location.search).toBe('')
    view.rerender(<HubIntegrationsPanel {...props} identity={other} />)
    expect(screen.queryByText('Available to this workspace')).toBeNull()
    expect(screen.queryByRole('button', { name: 'More actions for Cloudbeds' })).toBeNull()
  })

  it('lists each connected account once with its inline host control and offers only unconnected providers to connect', async () => {
    const f = fixture()
    const unconnected: HubProvider = { ...provider, providerId: 'github', title: 'GitHub', authKind: 'oauth2' }
    f.setConnections([connection, { ...connection, id: 'conn_2', accountDisplay: 'Hotel B' }])
    const client: HubIntegrationsClient = { ...f.client, providers: async () => [provider, unconnected] }
    let enabled = new Set(['conn_1'])
    const change = vi.fn()
    const accounts = () => ({
      title: 'Accounts', emptyLabel: 'No accounts connected yet.',
      getStatus: (account: HubConnection) => enabled.has(account.id)
        ? { label: 'Enabled for this agent', tone: 'success' as const } : { label: 'Not enabled', tone: 'neutral' as const },
      getPrimaryAction: (account: HubConnection) => ({
        id: 'agent-access', label: enabled.has(account.id) ? 'Remove from agent' : 'Enable for this agent', onSelect: () => change(account.id),
      }),
    })
    const view = render(<HubIntegrationsPanel identity={identity} client={client} can={allow} callbackPath="/integrations/callback"
      title="Connect an account" accounts={accounts()} />)
    const list = await screen.findByRole('list', { name: 'Accounts' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map(row => row.textContent)).toEqual([
      expect.stringContaining('Hotel A'), expect.stringContaining('Hotel B'),
    ])
    expect(within(rows[0]!).getByText('Enabled for this agent')).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Account for Cloudbeds' })).toBeNull()
    expect(screen.queryByTestId('integration-cloudbeds')).toBeNull()
    expect(screen.getByTestId('integration-github').getAttribute('data-connected')).toBe('false')
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Enable for this agent' }))
    expect(change).toHaveBeenCalledExactlyOnceWith('conn_2')
    enabled = new Set(['conn_2'])
    view.rerender(<HubIntegrationsPanel identity={identity} client={client} can={allow} callbackPath="/integrations/callback"
      title="Connect an account" accounts={accounts()} />)
    expect(within(screen.getByTestId('hub-account-conn_2')).getByText('Enabled for this agent')).toBeTruthy()
    expect(within(screen.getByTestId('hub-account-conn_1')).getByRole('button', { name: 'Enable for this agent' })).toBeTruthy()
    fireEvent.click(within(screen.getByTestId('hub-account-conn_2')).getByRole('button', { name: 'Manage Cloudbeds account Hotel B' }))
    await waitFor(() => expect(window.location.search).toBe('?integration=cloudbeds&connection=conn_2'))
    const access = await screen.findByTestId('hub-account-access')
    expect(within(access).getByText('Enabled for this agent')).toBeTruthy()
    expect(within(access).getByRole('button', { name: 'Remove from agent' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect another account' })).toBeTruthy()
  })

  it('offers a provider again once its only account is disconnected', async () => {
    const f = fixture()
    f.setConnections([{ ...connection, status: 'revoked' }])
    render(<HubIntegrationsPanel identity={identity} client={f.client} can={allow} callbackPath="/integrations/callback"
      title="Connect an account" accounts={{ title: 'Accounts', emptyLabel: 'No accounts connected yet.' }} />)
    const tile = await screen.findByTestId('integration-cloudbeds')
    expect(tile.getAttribute('data-connected')).toBe('false')
    expect(screen.getByText('No accounts connected yet.')).toBeTruthy()
    expect(screen.queryByTestId('hub-account-conn_1')).toBeNull()
    fireEvent.click(tile)
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('names a failed account read instead of rendering an empty account list', async () => {
    const f = fixture()
    const client: HubIntegrationsClient = { ...f.client, connections: async () => { throw new Error('Hub unavailable') } }
    render(<HubIntegrationsPanel identity={identity} client={client} can={allow} callbackPath="/integrations/callback"
      accounts={{ title: 'Accounts', emptyLabel: 'No accounts connected yet.' }} />)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Hub unavailable'))
    expect(screen.queryByText('No accounts connected yet.')).toBeNull()
    expect(screen.queryByTestId('integration-cloudbeds')).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it.each(['custom', 'none'] as const)('reaches an explicit host connector for a %s provider', async authKind => {
    const f = fixture()
    const custom: HubProvider = { ...provider, providerId: 'native', title: 'Native provider', authKind, configured: false }
    const client: HubIntegrationsClient = { ...f.client, providers: async () => [custom], connections: async () => [] }
    const onUnsupportedConnect = vi.fn()
    render(<HubIntegrationsPanel identity={identity} client={client} can={allow}
      callbackPath="/integrations/callback" onUnsupportedConnect={onUnsupportedConnect} />)
    const connect = await screen.findByTestId('integration-native')
    fireEvent.click(connect)
    expect(onUnsupportedConnect).toHaveBeenCalledWith(custom)
  })

  it('hides the prior account dialog and entered secret on an identity switch', async () => {
    const f = fixture()
    const client: HubIntegrationsClient = {
      ...f.client,
      providers: async () => [provider],
      connections: async () => [],
    }
    const { rerender } = render(<HubIntegrationsPanel identity={identity} client={client} can={allow} callbackPath="/integrations/callback" />)
    fireEvent.click(await screen.findByTestId('integration-cloudbeds'))
    const keyField = screen.getByLabelText('API key') as HTMLInputElement
    fireEvent.change(keyField, { target: { value: 'first-user-secret' } })
    expect(keyField.value).toBe('first-user-secret')
    rerender(<HubIntegrationsPanel identity={other} client={client} can={allow} callbackPath="/integrations/callback" />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByDisplayValue('first-user-secret')).toBeNull()
  })

  it('does not let an old write close the new identity dialog', async () => {
    const f = fixture()
    const pending = deferred<HubConnection>()
    let saved = false
    const client: HubIntegrationsClient = {
      ...f.client,
      providers: async () => [provider],
      connections: async current => saved && current.workspaceId === identity.workspaceId ? [connection] : [],
      connectApiKey: async () => { const created = await pending.promise; saved = true; return created },
    }
    const { rerender } = render(<HubIntegrationsPanel identity={identity} client={client} can={allow} callbackPath="/integrations/callback" />)
    fireEvent.click(await screen.findByTestId('integration-cloudbeds'))
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'first-user-secret' } })
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }))
    rerender(<HubIntegrationsPanel identity={other} client={client} can={allow} callbackPath="/integrations/callback" />)
    fireEvent.click(await screen.findByTestId('integration-cloudbeds'))
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'second-user-secret' } })
    await act(async () => { pending.resolve(connection); await Promise.resolve() })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByDisplayValue('second-user-secret')).toBeTruthy()
  })

  it('keeps a reopened dialog intact while an earlier key write settles', async () => {
    const f = fixture()
    const pending = deferred<HubConnection>()
    let saved = false
    const client: HubIntegrationsClient = {
      ...f.client,
      providers: async () => [provider],
      connections: async () => saved ? [connection] : [],
      connectApiKey: async () => { const created = await pending.promise; saved = true; return created },
    }
    render(<HubIntegrationsPanel identity={identity} client={client} can={allow} callbackPath="/integrations/callback" />)
    fireEvent.click(await screen.findByTestId('integration-cloudbeds'))
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'first-key' } })
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }))
    expect(screen.getByText('Saving Hub settings…')).toBeTruthy()
    expect(screen.queryByText('Connection was cancelled.')).toBeNull()
    fireEvent.click(screen.getByTestId('integration-cloudbeds'))
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'second-key' } })
    await act(async () => { pending.resolve(connection); await Promise.resolve() })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByDisplayValue('second-key')).toBeTruthy()
  })

  it('offers explicit cancellation while an OAuth popup is pending', async () => {
    const f = fixture()
    const oauth: HubProvider = { ...provider, authKind: 'oauth2' }
    const popup = { closed: false, close: vi.fn(), location: { href: '' } } as unknown as Window
    vi.spyOn(window, 'open').mockReturnValue(popup)
    const client: HubIntegrationsClient = {
      ...f.client,
      providers: async () => [oauth],
      connections: async () => [],
      startOAuth: async () => ({ provider: 'cloudbeds', redirectUrl: 'https://provider.example/authorize',
        state: 'state', expiresAt: '2026-10-02T02:00:00Z', scopes: [], cli: false }),
    }
    render(<HubIntegrationsPanel identity={identity} client={client} can={allow} callbackPath="/integrations/callback" />)
    fireEvent.click(await screen.findByTestId('integration-cloudbeds'))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel connection' }))
    expect(await screen.findByTestId('integration-connect-error')).toHaveProperty('textContent', 'Connection was cancelled.')
    expect(popup.close).toHaveBeenCalled()
  })

  it('discards delayed reads from a prior session and workspace', async () => {
    const f = fixture()
    const oldProviders = deferred<HubProvider[]>()
    const oldConnections = deferred<HubConnection[]>()
    const client: HubIntegrationsClient = {
      ...f.client,
      providers: id => id.sessionId === identity.sessionId ? oldProviders.promise : Promise.resolve([{ ...provider, providerId: 'github', title: 'GitHub' }]),
      connections: id => id.sessionId === identity.sessionId ? oldConnections.promise : Promise.resolve([{ ...connection, id: 'conn_2', providerId: 'github' }]),
    }
    const { result, rerender } = renderHook(({ current }) => useHubIntegrations({ identity: current, client, can: allow, callbackPath: '/integrations/callback' }), { initialProps: { current: identity } })
    rerender({ current: other })
    await waitFor(() => expect(result.current.rows[0]?.providerId).toBe('github'))
    await act(async () => { oldProviders.resolve([provider]); oldConnections.resolve([connection]); await Promise.resolve() })
    expect(result.current.rows.map(row => row.providerId)).toEqual(['github'])
    expect(result.current.rows[0]?.connections[0]?.id).toBe('conn_2')
  })

  it('does not carry a pending permission write into a different workspace', async () => {
    const f = fixture()
    const pendingWrite = deferred<HubPolicy>()
    const client: HubIntegrationsClient = { ...f.client, setPolicy: () => pendingWrite.promise }
    const { result, rerender } = renderHook(({ current }) => useHubIntegrations({ identity: current, client, can: allow, callbackPath: '/integrations/callback' }), { initialProps: { current: identity } })
    await waitFor(() => expect(result.current.connections.status).toBe('ready'))
    let completion!: ReturnType<typeof result.current.setDecision>
    act(() => { completion = result.current.setDecision('conn_1', tool.path, 'deny') })
    expect(result.current.writeState.status).toBe('pending')
    rerender({ current: other })
    expect(result.current.writeState.status).toBe('idle')
    await act(async () => {
      pendingWrite.resolve({ id: 'policy_1', providerId: 'cloudbeds', connectionId: 'conn_1', actionPath: tool.path, decision: 'deny', createdAt: 'now', updatedAt: 'now' })
      await completion
    })
    expect(result.current.writeState.status).toBe('idle')
    expect(result.current.rows).toEqual([])
  })

  it('marks the capped action list incomplete rather than presenting it as exhaustive', async () => {
    const f = fixture()
    const client: HubIntegrationsClient = { ...f.client, actions: async () => Array.from({ length: 200 }, (_, index) => ({ ...tool, path: `cloudbeds.action${index}` })) }
    const { result } = renderHook(() => useHubIntegrations({ identity, client, can: allow, callbackPath: '/integrations/callback' }))
    await waitFor(() => expect(result.current.connections.status).toBe('ready'))
    act(() => result.current.selectConnection('cloudbeds', 'conn_1'))
    await waitFor(() => expect(result.current.detail.status).toBe('ready'))
    if (result.current.detail.status !== 'ready') throw new Error('Expected a detail result')
    expect(result.current.detail.value.truncated).toBe(true)
  })
})

describe('OAuth completion fencing', () => {
  it('sends a return URL that the settings server accepts for the named callback path', async () => {
    const started: unknown[] = []
    const hub = new HubClient({ baseUrl: 'https://hub.example', apiKey: 'server-only-key', fetch: async (input, init) => {
      const url = new URL(String(input))
      if (!url.pathname.endsWith('/github/start')) throw new Error(`Unexpected SDK request: ${url.pathname}`)
      started.push(JSON.parse(String(init?.body)))
      return Response.json({ success: true, data: { provider: 'github', redirectUrl: 'https://github.com/login/oauth/authorize', state: 's', expiresAt: 'later', scopes: [], cli: false } })
    } })
    const routes = createHubSettingsRoutes({
      oauthCallbackPath: '/app/agent_1/integrations/connect-callback',
      authorize: async () => ({ authorized: true as const, principal: identity }),
      resolveClient: async principal => ({ principal, credentialSource: 'caller-account', client: hub }),
    })
    const client = createHubIntegrationsClient(({ path, init }) => routes.handle(new Request(`${window.location.origin}${path}`, init)))
    const popup = { closed: false, close: vi.fn(), location: { href: '' } } as unknown as Window
    vi.spyOn(window, 'open').mockReturnValue(popup)
    const controller = new AbortController()
    const pending = connectWithPopup({ client, identity, providerId: 'github', before: [], callbackPath: '/app/agent_1/integrations/connect-callback', signal: controller.signal, isCurrent: () => true })
    await vi.waitFor(() => expect(popup.location.href).toBe('https://github.com/login/oauth/authorize'))
    expect(started).toHaveLength(1)
    controller.abort()
    expect(await pending).toBe('cancelled')
  })

  it('never treats a broadcast or pre-existing provider connection as completion', async () => {
    vi.useFakeTimers()
    const channels: Array<{ onmessage: ((event: { data: unknown }) => void) | null; close: () => void }> = []
    class Channel {
      onmessage: ((event: { data: unknown }) => void) | null = null
      close = vi.fn()
      constructor() { channels.push(this) }
    }
    vi.stubGlobal('BroadcastChannel', Channel)
    const popup = { closed: false, close: vi.fn(), location: { href: '' } } as unknown as Window
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)
    let after = [connection]
    let returnUrl = ''
    const client = {
      startOAuth: vi.fn(async (_identity, _provider, input: { returnUrl: string }) => { returnUrl = input.returnUrl; return { redirectUrl: 'https://provider.example/authorize' } }),
      connections: vi.fn(async () => after),
    } as unknown as ReturnType<typeof createHubIntegrationsClient>
    const controller = new AbortController()
    let settled = false
    const pending = connectWithPopup({ client, identity, providerId: 'cloudbeds', before: [connection], callbackPath: '/integrations/callback', signal: controller.signal, isCurrent: () => true }).then(value => { settled = true; return value })
    expect(open).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(returnUrl).toContain('nonce='))
    const callback = new URL(returnUrl)
    channels[0]?.onmessage?.({ data: { type: HUB_CONNECTED_MESSAGE_TYPE, provider: 'cloudbeds', nonce: callback.searchParams.get('nonce'), context: 'wrong' } })
    channels[0]?.onmessage?.({ data: { type: HUB_CONNECTED_MESSAGE_TYPE, provider: 'cloudbeds', nonce: callback.searchParams.get('nonce'), context: callback.searchParams.get('context') } })
    await Promise.resolve()
    expect(settled).toBe(false)
    after = [{ ...connection, updatedAt: '2026-10-02T02:00:00Z' }]
    await vi.advanceTimersByTimeAsync(2500)
    expect(await pending).toBe('connected')
    expect(popup.close).toHaveBeenCalled()
    expect(POPUP_TIMEOUT_MS).toBeGreaterThan(2500)
  })

  it('signals only an opaque completion with matching context, never a grant', async () => {
    const sent: unknown[] = []
    class Channel { postMessage(value: unknown) { sent.push(value) } close() {} }
    vi.stubGlobal('BroadcastChannel', Channel)
    window.history.replaceState(null, '', '/integrations/callback?provider=github&nonce=opaque&context=flow')
    vi.spyOn(window, 'close').mockImplementation(() => {})
    render(<HubConnectCallbackPage returnHref="/settings" />)
    await waitFor(() => expect(sent).toEqual([{ type: HUB_CONNECTED_MESSAGE_TYPE, provider: 'github', nonce: 'opaque', context: 'flow' }]))
    expect(screen.getByRole('link', { name: 'Return to integrations' }).getAttribute('href')).toBe('/settings')
  })

  it.each(['/\\example.test/return', '//example.test/return'])('keeps an external-looking return path local: %s', returnHref => {
    render(<HubConnectCallbackPage returnHref={returnHref} />)
    expect(screen.getByRole('link', { name: 'Return to integrations' }).getAttribute('href')).toBe('/')
  })

  it('keeps the local return link when server rendering has no window', () => {
    vi.stubGlobal('window', undefined)
    const markup = renderToStaticMarkup(<HubConnectCallbackPage returnHref="/settings?tab=integrations" />)
    expect(markup).toContain('href="/settings?tab=integrations"')
  })

  it.each(['/\\example.test/callback', '//example.test/callback'])('rejects an external-looking callback before opening a popup: %s', async callbackPath => {
    const open = vi.spyOn(window, 'open')
    const startOAuth = vi.fn()
    const client = { startOAuth } as unknown as HubIntegrationsClient
    await expect(connectWithPopup({ client, identity, providerId: 'github', before: [], callbackPath,
      signal: new AbortController().signal, isCurrent: () => true })).rejects.toThrow('Callback path must be local.')
    expect(open).not.toHaveBeenCalled()
    expect(startOAuth).not.toHaveBeenCalled()
  })

  it('returns a blocked state before requesting an OAuth redirect', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const startOAuth = vi.fn()
    const client = { startOAuth } as unknown as HubIntegrationsClient
    const result = await connectWithPopup({ client, identity, providerId: 'github', before: [], callbackPath: '/integrations/callback', signal: new AbortController().signal, isCurrent: () => true })
    expect(result).toBe('blocked')
    expect(open).toHaveBeenCalledTimes(1)
    expect(startOAuth).not.toHaveBeenCalled()
  })

  it('polls successfully when BroadcastChannel is unavailable and cancels on context abort', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('BroadcastChannel', class { constructor() { throw new Error('unavailable') } })
    const popup = { closed: false, close: vi.fn(), location: { href: '' } } as unknown as Window
    vi.spyOn(window, 'open').mockReturnValue(popup)
    let after: HubConnection[] = []
    const client = { startOAuth: async () => ({ redirectUrl: 'https://provider.example/authorize' }), connections: async () => after } as unknown as HubIntegrationsClient
    const controller = new AbortController()
    const first = connectWithPopup({ client, identity, providerId: 'cloudbeds', before: [], callbackPath: '/integrations/callback', signal: controller.signal, isCurrent: () => true })
    await Promise.resolve()
    after = [connection]
    await vi.advanceTimersByTimeAsync(2500)
    expect(await first).toBe('connected')
    const second = connectWithPopup({ client, identity, providerId: 'cloudbeds', before: [connection], callbackPath: '/integrations/callback', signal: controller.signal, isCurrent: () => true })
    await Promise.resolve()
    controller.abort()
    expect(await second).toBe('cancelled')
  })

  it('keeps polling when COOP severs a live popup handle', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('BroadcastChannel', class { constructor() { throw new Error('unavailable') } })
    const popup = { closed: true, close: vi.fn(), location: { href: '' } } as unknown as Window
    vi.spyOn(window, 'open').mockReturnValue(popup)
    let after: HubConnection[] = []
    const connections = vi.fn(async () => after)
    const client = { startOAuth: async () => ({ redirectUrl: 'https://provider.example/authorize' }), connections } as unknown as HubIntegrationsClient
    const pending = connectWithPopup({ client, identity, providerId: 'cloudbeds', before: [connection],
      callbackPath: '/integrations/callback', signal: new AbortController().signal, isCurrent: () => true })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(2500)
    expect(connections).toHaveBeenCalledTimes(1)
    after = [{ ...connection, updatedAt: '2026-10-02T02:00:00Z' }]
    await vi.advanceTimersByTimeAsync(2500)
    expect(await pending).toBe('connected')
  })
})
