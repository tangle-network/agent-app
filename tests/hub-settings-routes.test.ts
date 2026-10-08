import { describe, expect, it, vi } from 'vitest'
import { HubClient, HubSdkError } from '@tangle-network/hub-sdk'
import {
  createHubSettingsRoutes,
  type HubSettingsClientBinding,
  type HubSettingsContext,
  type HubSettingsGrant,
  type HubSettingsOperation,
  type HubSettingsPrincipal,
} from '../src/platform/index'

const BASE = 'https://app.example/api/hub/settings'
const PRINCIPAL: HubSettingsPrincipal = { userId: 'user-1', sessionId: 'session-1', workspaceId: 'workspace-1' }
const DATA = { marker: 'SDK response, not an app-side reimplementation' }
const OAUTH = {
  provider: 'github', redirectUrl: 'https://github.com/login/oauth/authorize', state: 'oauth-state',
  expiresAt: '2026-10-01T01:00:00Z', scopes: ['read:user', 'repo', 'read:org'], cli: false,
}

function request(path: string, method = 'GET', input?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  })
}

function fixture(data: unknown = DATA) {
  // Real SDK methods + HTTP-envelope parsing. Only the upstream transport is fake.
  const upstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ success: true, data }))
  const client = new HubClient({ baseUrl: 'https://hub.example', apiKey: 'server-caller-account-key', fetch: upstream })
  const authorize = vi.fn<HubSettingsContext['authorize']>(async () => ({ authorized: true, principal: PRINCIPAL }))
  const resolveClient = vi.fn<HubSettingsContext['resolveClient']>(async (principal) => ({
    principal, credentialSource: 'caller-account', client,
  }))
  const routes = createHubSettingsRoutes({ authorize, resolveClient })
  return { routes, client, authorize, resolveClient, upstream }
}

const cases: Array<{
  path: string; method: string; input?: unknown; intent: HubSettingsOperation
  upstreamPath: string; upstreamMethod: string; upstreamBody?: unknown; data?: unknown
}> = [
  { path: '/providers', method: 'GET', intent: { operation: 'providers.list', target: 'caller-account' }, upstreamPath: '/v1/hub/providers', upstreamMethod: 'GET' },
  { path: '/connections', method: 'GET', intent: { operation: 'connections.list', target: 'caller-account' }, upstreamPath: '/v1/hub/connections', upstreamMethod: 'GET' },
  {
    path: '/connections/github/start', method: 'POST', data: OAUTH,
    input: { returnUrl: 'https://app.example/settings' },
    intent: { operation: 'oauth.start', provider: 'github', input: { returnUrl: 'https://app.example/settings' } },
    upstreamPath: '/v1/hub/connections/github/start', upstreamMethod: 'POST',
    upstreamBody: { returnUrl: 'https://app.example/settings' },
  },
  {
    path: '/connections/cloudbeds/connect-key', method: 'POST',
    input: { apiKey: 'provider-only-key', metadata: { propertyId: 'property-42', currency: 'USD' } },
    intent: { operation: 'api-key.connect', provider: 'cloudbeds', metadata: { propertyId: 'property-42', currency: 'USD' } },
    upstreamPath: '/v1/hub/connections/cloudbeds/connect-key', upstreamMethod: 'POST',
    upstreamBody: { apiKey: 'provider-only-key', metadata: { propertyId: 'property-42', currency: 'USD' } },
  },
  { path: '/connections/connection-1', method: 'DELETE', intent: { operation: 'connection.revoke', connectionId: 'connection-1' }, upstreamPath: '/v1/hub/connections/connection-1', upstreamMethod: 'DELETE' },
  { path: '/connections/connection-1/health', method: 'POST', intent: { operation: 'connection.health', connectionId: 'connection-1' }, upstreamPath: '/v1/hub/connections/connection-1/health', upstreamMethod: 'POST' },
  {
    path: '/providers/github/actions?query=issues&limit=25', method: 'GET',
    intent: { operation: 'provider.actions', provider: 'github', query: 'issues', limit: 25 },
    upstreamPath: '/v1/hub/tools/search', upstreamMethod: 'POST', upstreamBody: { query: 'issues', provider: 'github', limit: 25 },
  },
  { path: '/policies?connectionId=connection-1', method: 'GET', intent: { operation: 'policies.list', connectionId: 'connection-1' }, upstreamPath: '/v1/hub/policies?connectionId=connection-1', upstreamMethod: 'GET' },
  {
    path: '/policies', method: 'PUT', input: { connectionId: 'connection-1', actionPath: 'github.issues.create', decision: 'ask' },
    intent: { operation: 'policy.set', connectionId: 'connection-1', actionPath: 'github.issues.create', decision: 'ask' },
    upstreamPath: '/v1/hub/policies', upstreamMethod: 'PUT', upstreamBody: { connectionId: 'connection-1', actionPath: 'github.issues.create', decision: 'ask' },
  },
  {
    path: '/policies', method: 'DELETE', input: { connectionId: 'connection-1', actionPath: 'github.issues.create' },
    intent: { operation: 'policy.reset', connectionId: 'connection-1', actionPath: 'github.issues.create' },
    upstreamPath: '/v1/hub/policies', upstreamMethod: 'DELETE', upstreamBody: { connectionId: 'connection-1', actionPath: 'github.issues.create' },
  },
]

describe('createHubSettingsRoutes: finite SDK settings boundary', () => {
  it.each(cases)('$method $path authorizes the exact intent before the single SDK operation', async (item) => {
    const f = fixture(item.data)
    const req = request(item.path, item.method, item.input)
    const response = await f.routes.handle(req)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(item.data ?? DATA)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(f.authorize).toHaveBeenCalledTimes(2)
    expect(f.authorize).toHaveBeenNthCalledWith(1, req, item.intent)
    expect(f.authorize).toHaveBeenNthCalledWith(2, req, item.intent)
    expect(f.resolveClient).toHaveBeenCalledExactlyOnceWith(PRINCIPAL)
    expect(f.authorize.mock.invocationCallOrder[0]).toBeLessThan(f.resolveClient.mock.invocationCallOrder[0]!)
    expect(f.resolveClient.mock.invocationCallOrder[0]).toBeLessThan(f.authorize.mock.invocationCallOrder[1]!)
    expect(f.authorize.mock.invocationCallOrder[1]).toBeLessThan(f.upstream.mock.invocationCallOrder[0]!)
    expect(f.upstream).toHaveBeenCalledTimes(1)
    const [url, init] = f.upstream.mock.calls[0]!
    expect(url).toBe(`https://hub.example${item.upstreamPath}`)
    expect(init?.method).toBe(item.upstreamMethod)
    expect(init?.body === undefined ? undefined : JSON.parse(String(init.body))).toEqual(item.upstreamBody)
  })

  it.each(cases)('denied $intent.operation performs zero client resolutions or upstream calls', async (item) => {
    const f = fixture(item.data)
    const denied = Response.json({ code: 'WORKSPACE_ROLE_DENIED' }, { status: 403 })
    f.authorize.mockResolvedValue(denied)
    expect(await f.routes.handle(request(item.path, item.method, item.input))).toBe(denied)
    expect(f.authorize).toHaveBeenCalledTimes(1)
    expect(f.resolveClient).not.toHaveBeenCalled()
    expect(f.upstream).not.toHaveBeenCalled()
  })

  it('preserves non-secret OAuth connection parameters without a workspace grant side effect', async () => {
    const f = fixture({ ...OAUTH, provider: 'slack' })
    const input = { returnUrl: 'https://app.example/settings', connectionParameters: { subdomain: 'owned-tenant' } }
    expect((await f.routes.handle(request('/connections/slack/start', 'POST', input))).status).toBe(200)
    expect(f.authorize.mock.calls[0]?.[1]).toEqual({ operation: 'oauth.start', provider: 'slack', input })
    expect(JSON.parse(String(f.upstream.mock.calls[0]?.[1]?.body))).toEqual(input)
    expect(f.upstream).toHaveBeenCalledTimes(1)
  })

  it('preserves PriceLabs metadata and does not turn the provider key into Hub authorization', async () => {
    const f = fixture()
    const input = { apiKey: 'provider-key-only', metadata: { listings: [{ id: 'listing-1', pms: 'airbnb' }] } }
    expect((await f.routes.handle(request('/connections/pricelabs/connect-key', 'POST', input))).status).toBe(200)
    const init = f.upstream.mock.calls[0]?.[1]
    expect(JSON.parse(String(init?.body))).toEqual(input)
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer server-caller-account-key')
    expect(f.authorize.mock.calls[0]?.[1]).toEqual({ operation: 'api-key.connect', provider: 'pricelabs', metadata: input.metadata })
  })

  it('connects providers that have no metadata without inventing it', async () => {
    const f = fixture()
    await f.routes.handle(request('/connections/airtable/connect-key', 'POST', { apiKey: 'provider-key-only' }))
    expect(JSON.parse(String(f.upstream.mock.calls[0]?.[1]?.body))).toEqual({ apiKey: 'provider-key-only' })
  })

  it('bounds discovery to one exact provider even when the query is omitted', async () => {
    const f = fixture()
    await f.routes.handle(request('/providers/github/actions'))
    expect(JSON.parse(String(f.upstream.mock.calls[0]?.[1]?.body))).toEqual({ query: '', provider: 'github', limit: 200 })
  })

  it.each(['allow', 'ask', 'deny'])('authorizes the exact single-action policy decision %s', async (decision) => {
    const f = fixture()
    const input = { connectionId: 'connection-1', actionPath: 'github.issues.create', decision }
    expect((await f.routes.handle(request('/policies', 'PUT', input))).status).toBe(200)
    expect(f.authorize.mock.calls[0]?.[1]).toEqual({ operation: 'policy.set', ...input })
  })

  it.each(['start', 'connect-key', 'health'])('treats the connection ID %s as a revoke target, not a suffix-selected operation', async (id) => {
    const f = fixture()
    expect((await f.routes.handle(request(`/connections/${id}`, 'DELETE'))).status).toBe(200)
    expect(f.authorize.mock.calls[0]?.[1]).toEqual({ operation: 'connection.revoke', connectionId: id })
    expect(f.upstream.mock.calls[0]?.[1]?.method).toBe('DELETE')
  })
})

describe('method/path and input allowlists', () => {
  it.each([
    ['/connections/c-1/health', 'POST'],
    ['/connections/c-1', 'DELETE'],
  ])('accepts an empty request stream for bodyless %s %s', async (path, method) => {
    const f = fixture()
    const req = new Request(`${BASE}${path}`, { method, body: '', headers: { 'Content-Length': '0' } })
    expect(req.body).not.toBeNull()
    expect((await f.routes.handle(req)).status).toBe(200)
    expect(f.authorize).toHaveBeenCalledTimes(2)
    expect(f.upstream).toHaveBeenCalledTimes(1)
  })

  it('rejects a nonempty stream on a bodyless route before authorization', async () => {
    const f = fixture()
    const req = new Request(`${BASE}/connections/c-1/health`, { method: 'POST', body: 'x', headers: { 'Content-Length': '0' } })
    expect((await f.routes.handle(req)).status).toBe(400)
    expect(f.authorize).not.toHaveBeenCalled()
    expect(f.upstream).not.toHaveBeenCalled()
  })

  it('rejects bytes after an empty stream chunk before authorization', async () => {
    const f = fixture()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array())
        controller.enqueue(new Uint8Array([120]))
        controller.close()
      },
    })
    const req = new Request(`${BASE}/connections/c-1/health`, { method: 'POST', body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' })
    expect((await f.routes.handle(req)).status).toBe(400)
    expect(f.authorize).not.toHaveBeenCalled()
    expect(f.upstream).not.toHaveBeenCalled()
  })

  it('bounds empty stream chunks before authorization', async () => {
    const f = fixture()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 17; index++) controller.enqueue(new Uint8Array())
        controller.close()
      },
    })
    const req = new Request(`${BASE}/connections/c-1/health`, { method: 'POST', body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' })
    expect((await f.routes.handle(req)).status).toBe(400)
    expect(f.authorize).not.toHaveBeenCalled()
    expect(f.upstream).not.toHaveBeenCalled()
  })

  it.each([
    '/exec', '/tokens', '/tokens/mint', '/apps', '/apps/app-1/grants', '/policies/allow-writes',
    '/policies/revert-writes', '/tools/search', '/tools/describe', '/workflows', '/v1/hub/exec',
    '/providers/', '/Providers', '/connections/c-1/health/extra', '/connections/c-1/start/extra',
  ])('never exposes %s', async (path) => {
    const f = fixture()
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      expect((await f.routes.handle(request(path, method))).status).toBe(404)
    }
    expect(f.authorize).not.toHaveBeenCalled()
    expect(f.resolveClient).not.toHaveBeenCalled()
    expect(f.upstream).not.toHaveBeenCalled()
  })

  it.each(cases)('rejects disallowed methods on $path with Allow and no upstream work', async (item) => {
    const f = fixture()
    const allowed = item.path.startsWith('/policies') ? ['GET', 'PUT', 'DELETE'] : [item.method]
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      if (allowed.includes(method)) continue
      const response = await f.routes.handle(request(item.path, method))
      expect(response.status).toBe(405)
      expect(response.headers.get('Allow')).toBe(allowed.join(', '))
    }
    expect(f.authorize).not.toHaveBeenCalled()
    expect(f.resolveClient).not.toHaveBeenCalled()
    expect(f.upstream).not.toHaveBeenCalled()
  })

  it.each([
    ['/connections/c%2Fother', 'DELETE'], ['/connections/%252F', 'DELETE'], ['/connections/*', 'DELETE'],
    ['/connections/%20owner', 'DELETE'], ['/providers/github%3FuserId/actions', 'GET'],
    ['/policies', 'GET'], ['/policies?connectionId=c-1&connectionId=c-2', 'GET'],
    ['/policies?connectionId=c-1&userId=other', 'GET'], ['/providers?workspaceId=other', 'GET'],
    ['/providers/github/actions?provider=other', 'GET'], ['/providers/github/actions?limit=201', 'GET'],
    ['/providers/github/actions?limit=0', 'GET'], ['/providers/github/actions?limit=1e2', 'GET'],
    ['/providers/github/actions?limit=5&limit=6', 'GET'],
    ['/providers/github/actions?query=issues%7F', 'GET'],
    ['/connections/c-1/health', 'POST', { userId: 'other' }],
    ['/connections/c-1', 'DELETE', { connectionId: 'c-2' }],
    ['/connections/github/start', 'POST', null], ['/connections/github/start', 'POST', []],
    ['/connections/github/start', 'POST', { returnUrl: 'https://other.example/settings' }],
    ['/connections/github/start', 'POST', { returnUrl: 'javascript:alert(1)' }],
    ['/connections/github/start', 'POST', { returnUrl: 'https://u:p@app.example/settings' }],
    ['/connections/github/start', 'POST', { returnUrl: 'https://app.example/settings', cli: true }],
    ['/connections/github/start', 'POST', { returnUrl: 'https://app.example/settings', connectionParameters: { workspaceId: 'other' } }],
    ['/connections/github/start', 'POST', { returnUrl: 'https://app.example/settings', connectionParameters: { api_key: 'credential' } }],
    ['/connections/github/start', 'POST', { returnUrl: 'https://app.example/settings', connectionParameters: { tenant: { nested: true } } }],
    ['/connections/github/start', 'POST', { returnUrl: 'https://app.example/settings\u007f' }],
    ['/connections/github/start', 'POST', { returnUrl: 'https://app.example/settings', requestedScopes: ['read:user', 'repo', 'read:org'] }],
    ['/connections/cloudbeds/connect-key', 'POST', { apiKey: 'key', metadata: { propertyId: 'p', userId: 'other' } }],
    ['/connections/pricelabs/connect-key', 'POST', { apiKey: 'key', metadata: { listings: [{ id: 'i', pms: 'p', ownerId: 'other' }] } }],
    ['/connections/pricelabs/connect-key', 'POST', { apiKey: 'key', metadata: { listings: [] } }],
    ['/connections/airtable/connect-key', 'POST', { apiKey: 42 }],
    ['/policies', 'PUT', { connectionId: 'c-1', actionPath: 'github.*', decision: 'allow' }],
    ['/policies', 'PUT', { connectionId: 'c-1', actionPath: 'github', decision: 'allow' }],
    ['/policies', 'PUT', { connectionId: 'c-1', actionPath: 'github.issues.create', decision: 'approve-all' }],
    ['/policies', 'DELETE', { connectionId: 'c-1', actionPath: 'github.issues.create', decision: 'allow' }],
    ['/policies', 'PUT', { connectionId: 'c-1', actionPaths: ['github.issues.create'], decision: 'allow' }],
  ] as Array<[string, string, unknown?]>)('rejects invalid target/input at %s %s', async (path, method, input) => {
    const f = fixture()
    expect((await f.routes.handle(request(path, method, input))).status).toBe(400)
    expect(f.authorize).not.toHaveBeenCalled()
    expect(f.resolveClient).not.toHaveBeenCalled()
    expect(f.upstream).not.toHaveBeenCalled()
  })

  it.each(['userId', 'sessionId', 'workspaceId', 'teamId', 'ownerId', 'principal', 'headers', 'authorization', 'token', 'baseUrl'])('rejects browser-selected %s rather than forwarding it', async (field) => {
    const f = fixture()
    const response = await f.routes.handle(request('/connections/airtable/connect-key', 'POST', { apiKey: 'provider-key', [field]: 'other-owner-or-credential' }))
    expect(response.status).toBe(400)
    expect(f.resolveClient).not.toHaveBeenCalled()
    expect(f.upstream).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON, wrong media type, and oversized bodies without resolving credentials', async () => {
    for (const [raw, media, status] of [['{', 'application/json', 400], ['{}', 'text/plain', 415], [JSON.stringify({ apiKey: 'x'.repeat(70_000) }), 'application/json', 413]] as const) {
      const f = fixture()
      const response = await f.routes.handle(new Request(`${BASE}/connections/airtable/connect-key`, { method: 'POST', headers: { 'Content-Type': media }, body: raw }))
      expect(response.status).toBe(status)
      expect(f.resolveClient).not.toHaveBeenCalled()
      expect(f.upstream).not.toHaveBeenCalled()
    }
  })

  it('supports an explicit mount without accepting adjacent prefixes or arbitrary /v1 paths', async () => {
    const f = fixture()
    const routes = createHubSettingsRoutes({ authorize: f.authorize, resolveClient: f.resolveClient, basePath: '/settings/hub' })
    for (const path of ['/settings/hub-other/providers', '/v1/hub/providers', '/api/hub/settings/providers']) {
      expect((await routes.handle(new Request(`https://app.example${path}`))).status).toBe(404)
    }
    expect(f.upstream).not.toHaveBeenCalled()
    expect((await routes.handle(new Request('https://app.example/settings/hub/providers'))).status).toBe(200)
  })

  it('accepts only the panel callback shape when the host names its callback path', async () => {
    const f = fixture(OAUTH)
    const routes = createHubSettingsRoutes({ authorize: f.authorize, resolveClient: f.resolveClient, oauthCallbackPath: '/app/a1/integrations/connect-callback' })
    const callback = 'https://app.example/app/a1/integrations/connect-callback'
    const accepted = `${callback}?provider=github&nonce=3f1c2b9e-7d4a-4c1e-9a55-0f2d6c8b1a77&context=b2a1c3d4-e5f6-4789-a012-3456789abcde`
    const response = await routes.handle(request('/connections/github/start', 'POST', { returnUrl: accepted }))
    expect(response.status).toBe(200)
    expect(f.authorize.mock.calls[0]?.[1]).toEqual({ operation: 'oauth.start', provider: 'github', input: { returnUrl: accepted } })
    const authorizedCalls = f.authorize.mock.calls.length
    for (const returnUrl of [
      callback,
      `${callback}?provider=slack&nonce=n1&context=c1`,
      `${callback}?provider=github&nonce=n1`,
      `${callback}?provider=github&nonce=n1&context=c1&next=%2Fadmin`,
      `${callback}?provider=github&nonce=n1&nonce=n2&context=c1`,
      `${callback}?provider=github&nonce=n%2F1&context=c1`,
      `${callback}?provider=github&nonce=n1&context=c1#fragment`,
      'https://app.example/app/a2/integrations/connect-callback?provider=github&nonce=n1&context=c1',
    ]) {
      expect((await routes.handle(request('/connections/github/start', 'POST', { returnUrl }))).status).toBe(400)
    }
    expect(f.authorize).toHaveBeenCalledTimes(authorizedCalls)
    expect(f.upstream).toHaveBeenCalledTimes(1)
    expect(() => createHubSettingsRoutes({ authorize: f.authorize, resolveClient: f.resolveClient, oauthCallbackPath: '//other.example/callback' })).toThrow('callback path')
  })
})

describe('application authority and caller-bound credentials', () => {
  it.each(['session-mismatch', 'denied-role'])('lets the application reject %s before credential lookup', async (reason) => {
    const f = fixture()
    // Application-owned fixture state, not browser identity or a simulated Hub grant.
    const activeSession = { ...PRINCIPAL, role: reason === 'denied-role' ? 'viewer' : 'owner' }
    f.authorize.mockImplementation(async (req) => {
      if (req.headers.get('Cookie') !== `session=${activeSession.sessionId}`) return Response.json({ code: 'SESSION_MISMATCH' }, { status: 401 })
      if (activeSession.role !== 'owner') return Response.json({ code: 'WORKSPACE_ROLE_DENIED' }, { status: 403 })
      return { authorized: true, principal: activeSession }
    })
    const response = await f.routes.handle(request('/connections/c-1', 'DELETE', undefined, { Cookie: `session=${reason === 'session-mismatch' ? 'old-session' : PRINCIPAL.sessionId}` }))
    expect(response.status).toBe(reason === 'session-mismatch' ? 401 : 403)
    expect(f.resolveClient).not.toHaveBeenCalled()
    expect(f.upstream).not.toHaveBeenCalled()
  })

  it('re-authorizes after a session loses access instead of caching an earlier grant', async () => {
    const f = fixture()
    expect((await f.routes.handle(request('/connections'))).status).toBe(200)
    f.authorize.mockResolvedValue(Response.json({ code: 'SESSION_REVOKED' }, { status: 401 }))
    expect((await f.routes.handle(request('/connections'))).status).toBe(401)
    expect(f.authorize).toHaveBeenCalledTimes(3)
    expect(f.resolveClient).toHaveBeenCalledTimes(1)
    expect(f.upstream).toHaveBeenCalledTimes(1)
  })

  it('refuses a grant revoked while resolving the caller credential', async () => {
    const f = fixture()
    const req = request('/connections/connection-1', 'DELETE')
    f.resolveClient.mockImplementation(async (principal) => {
      f.authorize.mockResolvedValue(Response.json({ code: 'SESSION_REVOKED' }, { status: 401 }))
      return { principal, credentialSource: 'caller-account', client: f.client }
    })
    const response = await f.routes.handle(req)
    expect(response.status).toBe(401)
    expect(f.authorize).toHaveBeenCalledTimes(2)
    expect(f.authorize.mock.calls[0]?.[1]).toBe(f.authorize.mock.calls[1]?.[1])
    expect(f.upstream).not.toHaveBeenCalled()
  })

  it('refuses a different principal granted during credential resolution', async () => {
    const f = fixture()
    f.resolveClient.mockImplementation(async (principal) => {
      f.authorize.mockResolvedValue({ authorized: true, principal: { ...PRINCIPAL, workspaceId: 'other-workspace' } })
      return { principal, credentialSource: 'caller-account', client: f.client }
    })
    expect((await f.routes.handle(request('/connections/connection-1/health', 'POST'))).status).toBe(403)
    expect(f.upstream).not.toHaveBeenCalled()
  })

  it.each(['userId', 'sessionId', 'workspaceId'] as const)('rejects a resolved %s mismatch before calling the SDK', async (field) => {
    const f = fixture()
    f.resolveClient.mockResolvedValue({ client: f.client, credentialSource: 'caller-account', principal: { ...PRINCIPAL, [field]: 'another-binding' } })
    expect((await f.routes.handle(request('/providers'))).status).toBe(403)
    expect(f.upstream).not.toHaveBeenCalled()
  })

  it.each(['brokered-execution', 'server-env', 'admin', undefined])('refuses credential source %s even for the same user', async (credentialSource) => {
    const f = fixture()
    f.resolveClient.mockResolvedValue({ client: f.client, principal: PRINCIPAL, credentialSource } as unknown as HubSettingsClientBinding)
    expect((await f.routes.handle(request('/connections'))).status).toBe(403)
    expect(f.upstream).not.toHaveBeenCalled()
  })

  it.each([undefined, null, false, 'user-1', { authorized: true, principal: { userId: 'user-1' } }])('fails closed on a missing/incomplete authorization grant: %j', async (grant) => {
    const f = fixture()
    f.authorize.mockResolvedValue(grant as HubSettingsGrant)
    expect((await f.routes.handle(request('/providers'))).status).toBe(403)
    expect(f.resolveClient).not.toHaveBeenCalled()
    expect(f.upstream).not.toHaveBeenCalled()
  })

  it('requires the authorization callback at construction time', () => {
    const f = fixture()
    // @ts-expect-error Exercise the runtime guard for an invalid JavaScript caller.
    expect(() => createHubSettingsRoutes({ resolveClient: f.resolveClient })).toThrow('authorize')
  })

  it('keeps browser headers and identity out of the SDK transport and resolver', async () => {
    const f = fixture()
    await f.routes.handle(request('/providers', 'GET', undefined, {
      Authorization: 'Bearer browser-privileged-key', Cookie: 'session=browser-session',
      'X-User-Id': 'another-owner', 'X-Workspace-Id': 'another-workspace', 'X-Api-Key': 'browser-admin-key',
    }))
    expect(f.resolveClient).toHaveBeenCalledExactlyOnceWith(PRINCIPAL)
    const headers = new Headers(f.upstream.mock.calls[0]?.[1]?.headers)
    expect(headers.get('Authorization')).toBe('Bearer server-caller-account-key')
    for (const name of ['Cookie', 'X-User-Id', 'X-Workspace-Id', 'X-Api-Key']) expect(headers.has(name)).toBe(false)
    expect(JSON.stringify(f.upstream.mock.calls)).not.toContain('another-owner')
    expect(JSON.stringify(f.upstream.mock.calls)).not.toContain('browser-privileged-key')
  })

  it('freezes the authorized intent and resolved principal so callbacks cannot retarget the call', async () => {
    const f = fixture()
    f.authorize.mockImplementation(async (_req, intent) => {
      expect(Reflect.set(intent, 'connectionId', 'other')).toBe(false)
      return { authorized: true, principal: PRINCIPAL }
    })
    f.resolveClient.mockImplementation(async (principal) => {
      expect(Reflect.set(principal, 'workspaceId', 'other')).toBe(false)
      return { principal, client: f.client, credentialSource: 'caller-account' }
    })
    await f.routes.handle(request('/policies', 'DELETE', { connectionId: 'connection-1', actionPath: 'github.issues.create' }))
    expect(JSON.parse(String(f.upstream.mock.calls[0]?.[1]?.body))).toEqual({ connectionId: 'connection-1', actionPath: 'github.issues.create' })
  })

  it('also freezes nested OAuth parameters before authorization', async () => {
    const f = fixture({ ...OAUTH, provider: 'slack' })
    f.authorize.mockImplementation(async (_req, intent) => {
      if (intent.operation !== 'oauth.start') throw new Error('wrong intent')
      expect(Reflect.set(intent.input.connectionParameters!, 'subdomain', 'other')).toBe(false)
      return { authorized: true, principal: PRINCIPAL }
    })
    await f.routes.handle(request('/connections/slack/start', 'POST', { returnUrl: 'https://app.example/settings', connectionParameters: { subdomain: 'owned' } }))
    expect(JSON.parse(String(f.upstream.mock.calls[0]?.[1]?.body)).connectionParameters).toEqual({ subdomain: 'owned' })
  })

  it('preserves application auth throws without resolving a client', async () => {
    const f = fixture()
    const redirect = new Response(null, { status: 302, headers: { Location: '/login' } })
    f.authorize.mockRejectedValue(redirect)
    await expect(f.routes.handle(request('/providers'))).rejects.toBe(redirect)
    expect(f.resolveClient).not.toHaveBeenCalled()
    expect(f.upstream).not.toHaveBeenCalled()
  })
})

describe('upstream error contract', () => {
  it.each([401, 403, 404, 409, 422, 429, 503])('preserves SDK status %s and code, without leaking details or retrying', async (status) => {
    const f = fixture()
    f.upstream.mockResolvedValue(Response.json({ success: false, error: { code: 'HUB_POLICY_DENIED', message: 'provider-only-key', details: { apiKey: 'provider-only-key' } } }, { status }))
    const response = await f.routes.handle(request('/connections/c-1/health', 'POST'))
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: 'Hub settings request failed', code: 'HUB_POLICY_DENIED' })
    expect(f.upstream).toHaveBeenCalledTimes(1)
  })

  it('preserves non-envelope HTTP failures reported by the SDK', async () => {
    const f = fixture()
    f.upstream.mockResolvedValue(new Response('upstream unavailable', { status: 502 }))
    const response = await f.routes.handle(request('/providers'))
    expect(response.status).toBe(502)
    expect((await response.json()).code).toBe('HUB_HTTP_502')
  })

  it('accepts structurally equivalent SDK errors from a duplicated module', async () => {
    const f = fixture()
    f.resolveClient.mockRejectedValue(Object.assign(new Error('private detail'), { name: 'HubSdkError', code: 'HUB_FORBIDDEN', status: 403 }))
    const response = await f.routes.handle(request('/providers'))
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe('HUB_FORBIDDEN')
    expect(f.upstream).not.toHaveBeenCalled()
  })

  it('does not disguise unrelated resolver failures as successful or authorized results', async () => {
    const f = fixture()
    const failure = new Error('application lookup failed')
    f.resolveClient.mockRejectedValue(failure)
    await expect(f.routes.handle(request('/providers'))).rejects.toBe(failure)
    expect(f.upstream).not.toHaveBeenCalled()
  })

  it('does not convert invalid SDK error statuses into successful responses', async () => {
    const f = fixture()
    f.resolveClient.mockRejectedValue(new HubSdkError({ code: 'HUB_CONFIG_MISSING', message: 'private' }, { status: 200 }))
    expect((await f.routes.handle(request('/providers'))).status).toBe(502)
    expect(f.upstream).not.toHaveBeenCalled()
  })
})
