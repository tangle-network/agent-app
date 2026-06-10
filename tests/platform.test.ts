import { describe, it, expect } from 'vitest'
import {
  createSignedSsoState,
  verifySignedSsoState,
  createTangleSsoHandlers,
  TangleSsoUserCreateError,
  createHubProxyRoutes,
  isTangleBearerMissingError,
  TangleBearerMissingError,
  type HubClientLike,
  type HubProxyContext,
  type TangleSsoAccountStore,
  type TangleSsoAuthClient,
  type TangleSsoExchangeResult,
} from '../src/platform/index'

const SECRET = 'test-secret'

describe('signed sso state', () => {
  it('round-trips: a freshly minted state verifies', async () => {
    const state = await createSignedSsoState({ secret: SECRET })
    expect(state.split('.')).toHaveLength(3)
    expect(await verifySignedSsoState(state, { secret: SECRET })).toBe(true)
  })

  it('rejects a tampered MAC', async () => {
    const state = await createSignedSsoState({ secret: SECRET })
    const flipped = state.slice(0, -1) + (state.endsWith('0') ? '1' : '0')
    expect(await verifySignedSsoState(flipped, { secret: SECRET })).toBe(false)
  })

  it('rejects a state signed with a different secret', async () => {
    const state = await createSignedSsoState({ secret: 'other' })
    expect(await verifySignedSsoState(state, { secret: SECRET })).toBe(false)
  })

  it('rejects malformed states', async () => {
    expect(await verifySignedSsoState('', { secret: SECRET })).toBe(false)
    expect(await verifySignedSsoState('a.b', { secret: SECRET })).toBe(false)
    expect(await verifySignedSsoState('a.b.c.d', { secret: SECRET })).toBe(false)
  })

  it('rejects an expired state via the signed timestamp', async () => {
    let t = 1_000_000_000
    const state = await createSignedSsoState({ secret: SECRET, now: () => t })
    expect(await verifySignedSsoState(state, { secret: SECRET, ttlMs: 600_000, now: () => t + 599_000 })).toBe(true)
    expect(await verifySignedSsoState(state, { secret: SECRET, ttlMs: 600_000, now: () => t + 601_000 })).toBe(false)
  })
})

/** Recording fakes: auth client + store capturing call order and inputs. */
function fakeHarness(overrides: {
  exchange?: (code: string) => Promise<TangleSsoExchangeResult>
  upsertUserByEmail?: TangleSsoAccountStore['upsertUserByEmail']
} = {}) {
  const calls: string[] = []
  const saved: Record<string, unknown> = {}
  const auth: TangleSsoAuthClient = {
    authorizeUrl: ({ state, redirectUri }) =>
      `https://id.example/cross-site/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri ?? '')}`,
    exchange:
      overrides.exchange ??
      (async (code) => {
        calls.push(`exchange:${code}`)
        return { apiKey: 'sk-tan-user-key', user: { id: 'tu_1', email: 'a@b.co', name: 'Ada' }, plan: { tier: 'pro' } }
      }),
  }
  const store: TangleSsoAccountStore = {
    upsertUserByEmail:
      overrides.upsertUserByEmail ??
      (async (input) => {
        calls.push('upsertUser')
        saved.user = input
        return { userId: 'u_1' }
      }),
    async createSession(input) {
      calls.push('createSession')
      saved.session = input
      return { token: 'tok_abc' }
    },
    async saveTangleLink(input) {
      calls.push('saveLink')
      saved.link = input
    },
  }
  const logs: unknown[][] = []
  const handlers = createTangleSsoHandlers({
    auth,
    store,
    stateSecret: SECRET,
    callbackUrl: 'https://my.app/auth/tangle/callback',
    stateCookieName: 'app_tangle_state',
    secureCookies: false,
    log: (...args) => logs.push(args),
  })
  return { handlers, calls, saved, logs }
}

function stateCookieFrom(response: Response): { header: string; payload: { s: string; r: string } } {
  const header = response.headers.getSetCookie().find((c) => c.startsWith('app_tangle_state=')) ?? ''
  const value = decodeURIComponent(header.split(';')[0]!.slice('app_tangle_state='.length))
  return { header, payload: JSON.parse(value) }
}

describe('createTangleSsoHandlers — start', () => {
  it('302s to the authorize URL with the state echoed into the cookie', async () => {
    const { handlers } = fakeHarness()
    const res = await handlers.start(new Request('https://my.app/auth/tangle/start?redirect=/app/x'))
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('Location')!)
    expect(location.origin + location.pathname).toBe('https://id.example/cross-site/authorize')
    expect(location.searchParams.get('redirect_uri')).toBe('https://my.app/auth/tangle/callback')
    const { header, payload } = stateCookieFrom(res)
    expect(payload.s).toBe(location.searchParams.get('state'))
    expect(payload.r).toBe('/app/x')
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Lax')
    expect(header).toContain('Max-Age=600')
    expect(header).not.toContain('Secure')
  })

  it('adds Secure when secureCookies is set', async () => {
    const { handlers } = fakeHarness()
    const secure = createTangleSsoHandlers({
      auth: { authorizeUrl: () => 'https://id.example/a', exchange: async () => ({ apiKey: '', user: { id: '', email: '' } }) },
      store: {} as TangleSsoAccountStore,
      stateSecret: SECRET,
      callbackUrl: 'https://my.app/cb',
      stateCookieName: 'app_tangle_state',
      secureCookies: true,
    })
    const res = await secure.start(new Request('https://my.app/auth/tangle/start'))
    expect(res.headers.getSetCookie()[0]).toContain('Secure')
    void handlers
  })

  it('falls back to the default path for absent and protocol-relative redirects', async () => {
    const { handlers } = fakeHarness()
    for (const qs of ['', '?redirect=//evil.com/x', '?redirect=https://evil.com']) {
      const res = await handlers.start(new Request(`https://my.app/auth/tangle/start${qs}`))
      expect(stateCookieFrom(res).payload.r).toBe('/app')
    }
  })
})

async function startThenCallback(
  harness: ReturnType<typeof fakeHarness>,
  mutate: (q: URLSearchParams, cookie: string) => { query: URLSearchParams; cookie: string } = (q, c) => ({ query: q, cookie: c }),
) {
  const startRes = await harness.handlers.start(new Request('https://my.app/auth/tangle/start?redirect=/app/x'))
  const { header, payload } = stateCookieFrom(startRes)
  const cookie = header.split(';')[0]!
  const query = new URLSearchParams({ code: 'code_1', state: payload.s })
  const m = mutate(query, cookie)
  return harness.handlers.callback(
    new Request(`https://my.app/auth/tangle/callback?${m.query}`, { headers: m.cookie ? { cookie: m.cookie } : {} }),
  )
}

describe('createTangleSsoHandlers — callback', () => {
  it('happy path: exchanges, upserts, creates session before link, sets cookies, redirects', async () => {
    const h = fakeHarness()
    const res = await startThenCallback(h)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/app/x')
    expect(h.calls).toEqual(['exchange:code_1', 'upsertUser', 'createSession', 'saveLink'])
    expect(h.saved.user).toEqual({ email: 'a@b.co', name: 'Ada' })
    expect(h.saved.link).toMatchObject({
      userId: 'u_1',
      sessionToken: 'tok_abc',
      tangleUserId: 'tu_1',
      apiKey: 'sk-tan-user-key',
      planTier: 'pro',
    })
    const cookies = res.headers.getSetCookie()
    expect(cookies).toHaveLength(2)
    expect(cookies[0]).toContain('app_tangle_state=;')
    expect(cookies[0]).toContain('Max-Age=0')
    expect(cookies[1]).toContain('better-auth.session_token=tok_abc')
    expect(cookies[1]).toContain('Max-Age=604800')
  })

  it('missing code/state → tangle_callback_missing with the state cookie cleared', async () => {
    const h = fakeHarness()
    const res = await h.handlers.callback(new Request('https://my.app/auth/tangle/callback'))
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/login?error=tangle_callback_missing')
    expect(res.headers.getSetCookie()[0]).toContain('Max-Age=0')
  })

  it('absent cookie → tangle_state_mismatch', async () => {
    const h = fakeHarness()
    const res = await startThenCallback(h, (q) => ({ query: q, cookie: '' }))
    expect(res.headers.get('Location')).toBe('/login?error=tangle_state_mismatch')
  })

  it('echoed state differing from the cookie → tangle_state_mismatch', async () => {
    const h = fakeHarness()
    const res = await startThenCallback(h, (q, cookie) => {
      q.set('state', 'not-the-state')
      return { query: q, cookie }
    })
    expect(res.headers.get('Location')).toBe('/login?error=tangle_state_mismatch')
  })

  it('expired state → tangle_state_mismatch', async () => {
    let t = 1_000_000_000
    const h = fakeHarness()
    const handlers = createTangleSsoHandlers({
      auth: {
        authorizeUrl: ({ state }) => `https://id.example/a?state=${encodeURIComponent(state)}`,
        exchange: async () => ({ apiKey: 'k', user: { id: 'tu', email: 'e@x.co' } }),
      },
      store: {} as TangleSsoAccountStore,
      stateSecret: SECRET,
      callbackUrl: 'https://my.app/cb',
      stateCookieName: 'app_tangle_state',
      secureCookies: false,
      now: () => t,
    })
    const startRes = await handlers.start(new Request('https://my.app/auth/tangle/start'))
    const { header, payload } = stateCookieFrom(startRes)
    t += 601_000
    const res = await handlers.callback(
      new Request(`https://my.app/cb?code=c&state=${encodeURIComponent(payload.s)}`, {
        headers: { cookie: header.split(';')[0]! },
      }),
    )
    expect(res.headers.get('Location')).toBe('/login?error=tangle_state_mismatch')
    void h
  })

  it('exchange failure → tangle_exchange_failed, logged', async () => {
    const h = fakeHarness({
      exchange: async () => {
        throw new Error('boom')
      },
    })
    const res = await startThenCallback(h)
    expect(res.headers.get('Location')).toBe('/login?error=tangle_exchange_failed')
    expect(h.logs).toHaveLength(1)
  })

  it('TangleSsoUserCreateError → tangle_user_create_failed', async () => {
    const h = fakeHarness({
      upsertUserByEmail: async () => {
        throw new TangleSsoUserCreateError()
      },
    })
    const res = await startThenCallback(h)
    expect(res.headers.get('Location')).toBe('/login?error=tangle_user_create_failed')
  })

  it('other store errors propagate (fail loud)', async () => {
    const h = fakeHarness({
      upsertUserByEmail: async () => {
        throw new Error('db down')
      },
    })
    await expect(startThenCallback(h)).rejects.toThrow('db down')
  })
})

// ── Hub proxy routes ────────────────────────────────────────────────────────

function fakeHubClient(overrides: Partial<HubClientLike> = {}): HubClientLike {
  return {
    catalog: async () => ({ providers: ['p1'] }),
    listConnections: async () => [{ id: 'conn_1' }],
    revokeConnection: async (id) => ({ connection: id, revokedGrants: 1 }),
    startAuth: async () => ({ authorizationUrl: 'https://id.example/oauth', state: 'st_1' }),
    listHealthchecks: async () => [{ ok: true }],
    ...overrides,
  }
}

function hubHarness(overrides: Partial<HubProxyContext> = {}) {
  const ctx: HubProxyContext = {
    requireUserId: async () => 'u_1',
    getBearer: async () => 'sk-tan-bearer',
    createHubClient: () => fakeHubClient(),
    ...overrides,
  }
  return createHubProxyRoutes(ctx)
}

const GET = (path = '/x') => ({ request: new Request(`https://my.app${path}`) })

describe('createHubProxyRoutes — success shapes', () => {
  it('catalog wraps the platform result', async () => {
    const res = await hubHarness().catalog(GET())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ catalog: { providers: ['p1'] } })
  })

  it('connections wraps the list', async () => {
    const res = await hubHarness().connections(GET())
    expect(await res.json()).toEqual({ connections: [{ id: 'conn_1' }] })
  })

  it('healthchecks wraps the list', async () => {
    const res = await hubHarness().healthchecks(GET())
    expect(await res.json()).toEqual({ healthchecks: [{ ok: true }] })
  })

  it('connectionDelete passes the platform result through verbatim', async () => {
    const res = await hubHarness().connectionDelete({
      request: new Request('https://my.app/x', { method: 'DELETE' }),
      params: { connectionId: 'conn_9' },
    })
    expect(await res.json()).toEqual({ connection: 'conn_9', revokedGrants: 1 })
  })

  it('authStart returns the authorization url + state', async () => {
    const res = await hubHarness().authStart({
      request: new Request('https://my.app/x', {
        method: 'POST',
        body: JSON.stringify({ providerId: 'google', connectorId: 'gmail', returnUrl: 'https://my.app/r' }),
      }),
    })
    expect(await res.json()).toEqual({ authorizationUrl: 'https://id.example/oauth', state: 'st_1' })
  })
})

describe('createHubProxyRoutes — method + body validation', () => {
  it('connectionDelete 405s on non-DELETE', async () => {
    const res = await hubHarness().connectionDelete({
      request: new Request('https://my.app/x', { method: 'POST' }),
      params: { connectionId: 'c' },
    })
    expect(res.status).toBe(405)
  })

  it('authStart 405s on non-POST', async () => {
    const res = await hubHarness().authStart(GET())
    expect(res.status).toBe(405)
  })

  it('authStart 400s on invalid JSON', async () => {
    const res = await hubHarness().authStart({
      request: new Request('https://my.app/x', { method: 'POST', body: 'not-json' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid JSON body' })
  })

  it('authStart 400s on missing fields', async () => {
    const res = await hubHarness().authStart({
      request: new Request('https://my.app/x', { method: 'POST', body: JSON.stringify({ providerId: 'g' }) }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'providerId, connectorId, and returnUrl are required' })
  })
})

describe('createHubProxyRoutes — error mapping', () => {
  it('maps a missing bearer to 412 tangle_link_required', async () => {
    const routes = hubHarness({
      getBearer: async (userId) => {
        throw new TangleBearerMissingError(userId)
      },
    })
    const res = await routes.catalog(GET())
    expect(res.status).toBe(412)
    expect(await res.json()).toEqual({ error: 'tangle_link_required' })
  })

  it('recognizes a structurally-faked bearer error from another module instance', async () => {
    const foreign = Object.assign(new Error('No Tangle platform link for user u_1'), {
      name: 'TangleBearerMissingError',
      userId: 'u_1',
    })
    expect(isTangleBearerMissingError(foreign)).toBe(true)
    const routes = hubHarness({
      getBearer: async () => {
        throw foreign
      },
    })
    expect((await routes.connections(GET())).status).toBe(412)
  })

  it('maps a PlatformHubError-shaped error to its status + code', async () => {
    const hubErr = Object.assign(new Error('upstream rejected'), { name: 'PlatformHubError', status: 502, code: 'bad_gateway' })
    const routes = hubHarness({
      createHubClient: () =>
        fakeHubClient({
          catalog: async () => {
            throw hubErr
          },
        }),
    })
    const res = await routes.catalog(GET())
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'upstream rejected', code: 'bad_gateway' })
  })

  it('rethrows unknown errors', async () => {
    const routes = hubHarness({
      getBearer: async () => {
        throw new Error('db down')
      },
    })
    await expect(routes.catalog(GET())).rejects.toThrow('db down')
  })

  it('propagates the auth throw untouched (e.g. a redirect Response)', async () => {
    const redirect = new Response(null, { status: 302, headers: { Location: '/login' } })
    const routes = hubHarness({
      requireUserId: async () => {
        throw redirect
      },
    })
    await expect(routes.catalog(GET())).rejects.toBe(redirect)
  })
})
