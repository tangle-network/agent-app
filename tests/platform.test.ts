import { describe, it, expect, vi } from 'vitest'
import {
  createSignedSsoState,
  verifySignedSsoState,
  createTangleSsoHandlers,
  createBetterAuthSessionCookieMinter,
  signSessionCookieValue,
  TangleSsoUserCreateError,
  createHubProxyRoutes,
  isTangleBearerMissingError,
  resolveUserTangleHubBearer,
  resolveUserTangleHubBearerForUser,
  guardResolution,
  TangleBearerMissingError,
  type HubClientLike,
  type HubProxyContext,
  type TangleSsoAccountStore,
  type TangleSsoAuthClient,
  type TangleSsoExchangeResult,
} from '../src/platform/index'

const SECRET = 'test-secret'
// Distinct from SECRET on purpose: the session cookie signs with the auth
// framework's secret, never the state secret.
const AUTH_SECRET = 'test-auth-secret'

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
    sessionCookieSecret: AUTH_SECRET,
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
      sessionCookieSecret: AUTH_SECRET,
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
    new Request(`https://my.app/auth/tangle/callback?${m.query}`, {
      headers: {
        ...(m.cookie ? { cookie: m.cookie } : {}),
        'x-forwarded-for': '9.9.9.9, 10.0.0.1',
      },
    }),
  )
}

describe('createTangleSsoHandlers — callback', () => {
  it('happy path: exchanges, upserts, creates session before link, sets cookies, redirects', async () => {
    const h = fakeHarness()
    const res = await startThenCallback(h)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/app/x')
    expect(h.calls).toEqual(['exchange:code_1', 'upsertUser', 'createSession', 'saveLink'])
    expect(h.saved.user).toEqual({ email: 'a@b.co', name: 'Ada', tangleUserId: 'tu_1' })
    expect(h.saved.session).toMatchObject({ ipAddress: '9.9.9.9' })
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
    const signedValue = encodeURIComponent(await signSessionCookieValue('tok_abc', AUTH_SECRET))
    expect(cookies[1]).toContain(`better-auth.session_token=${signedValue}`)
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
      sessionCookieSecret: AUTH_SECRET,
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

describe('resolveUserTangleHubBearer', () => {
  it('uses TANGLE_API_KEY in local development', async () => {
    await expect(resolveUserTangleHubBearer({
      userId: 'u_1',
      environment: 'development',
      env: { TANGLE_API_KEY: ' sk-local ' },
      getUserApiKey: async () => 'sk-user',
    })).resolves.toEqual({ bearer: 'sk-local', source: 'local-env' })
  })

  it('can infer local development from env', async () => {
    await expect(resolveUserTangleHubBearer({
      userId: 'u_1',
      env: { APP_ENV: 'local', TANGLE_API_KEY: 'sk-local' },
      getUserApiKey: async () => 'sk-user',
    })).resolves.toEqual({ bearer: 'sk-local', source: 'local-env' })
  })

  it('falls back to the linked user key when local development has no env key', async () => {
    await expect(resolveUserTangleHubBearer({
      userId: 'u_1',
      environment: 'development',
      env: {},
      getUserApiKey: async () => ' sk-user ',
    })).resolves.toEqual({ bearer: 'sk-user', source: 'user' })
  })

  it('uses the linked user key in deployed environments', async () => {
    await expect(resolveUserTangleHubBearer({
      userId: 'u_1',
      env: { APP_ENV: 'production', TANGLE_API_KEY: 'sk-env-ignored' },
      getUserApiKey: async () => ' sk-user ',
    })).resolves.toEqual({ bearer: 'sk-user', source: 'user' })
  })

  it('passes the user id through the app storage seam', async () => {
    await expect(resolveUserTangleHubBearerForUser({
      userId: 'u_1',
      env: { APP_ENV: 'production', TANGLE_API_KEY: 'sk-env-ignored' },
      getUserApiKey: async (userId) => userId === 'u_1' ? 'sk-user' : null,
    })).resolves.toEqual({ bearer: 'sk-user', source: 'user' })
  })

  it('throws the hub missing-link error when no bearer resolves', async () => {
    await expect(resolveUserTangleHubBearer({
      userId: 'u_1',
      environment: 'development',
      env: {},
      getUserApiKey: async () => null,
    })).rejects.toMatchObject({
      name: 'TangleBearerMissingError',
      userId: 'u_1',
    })
  })
})

// ── Platform billing HTTP + tier state ──────────────────────────────────────

import {
  createPlatformBillingHttp,
  createTanglePlatformBillingClient,
  isPlatformBillingHttpError,
  normalizeTanglePlanTier,
  readTangleTierState,
  type PlatformBillingHttp,
} from '../src/platform/index'
import { createPlatformBalanceManager } from '../src/billing/index'
import {
  assertBillableBalance,
  createAdminGuard,
  createAuthGuard,
  parseAdminEmails,
} from '../src/platform/index'

/** fetchImpl fake recording every call and answering from a route table. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = []
  const impl: typeof fetch = async (input, init) => {
    const url = String(input)
    const path = new URL(url).pathname
    const route = routes[path]
    if (!route) throw new Error(`no fake route for ${path}`)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    })
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { impl, calls }
}

function billingHttp(routes: Record<string, { status?: number; body: unknown }>) {
  const f = fakeFetch(routes)
  const http = createPlatformBillingHttp({
    baseUrl: 'https://id.example/',
    serviceToken: 'svc-token',
    productSlug: 'my-agent',
    fetchImpl: f.impl,
  })
  return { http, calls: f.calls }
}

describe('normalizeTanglePlanTier', () => {
  it('passes pro/enterprise through and maps everything else to free', () => {
    expect(normalizeTanglePlanTier('pro')).toBe('pro')
    expect(normalizeTanglePlanTier('enterprise')).toBe('enterprise')
    expect(normalizeTanglePlanTier('legacy')).toBe('free')
    expect(normalizeTanglePlanTier(null)).toBe('free')
    expect(normalizeTanglePlanTier(undefined)).toBe('free')
  })
})

describe('createPlatformBillingHttp', () => {
  it('reads send the user bearer and no service headers', async () => {
    const { http, calls } = billingHttp({
      '/v1/plans/current': { body: { success: true, data: { subscription: { plan: 'pro', status: 'active' } } } },
    })
    const sub = await http.getSubscription('sk-user-key')
    expect(sub).toEqual({ tier: 'pro', status: 'active' })
    expect(calls[0]!.headers.get('Authorization')).toBe('Bearer sk-user-key')
    expect(calls[0]!.headers.get('X-Service-Name')).toBeNull()
  })

  it('parses balance and usage with zero defaults', async () => {
    const { http } = billingHttp({
      '/v1/billing/balance': { body: { success: true, data: { balance: 12.5, lifetimeSpent: 40 } } },
      '/v1/billing/usage': { body: { success: true, data: [{ product: 'my-agent', totalSpent: 3 }] } },
    })
    expect(await http.getBalance('k')).toEqual({ balance: 12.5, lifetimeSpent: 40, updatedAt: undefined })
    expect(await http.getUsageByProduct('k')).toEqual([{ product: 'my-agent', totalSpent: 3, count: 0 }])
  })

  it('deduct authenticates as the service and names the user in the body', async () => {
    const { http, calls } = billingHttp({ '/v1/billing/deduct': { body: { success: true } } })
    await http.deduct({ platformUserId: 'pu_1', amountUsd: 0.42, type: 'agent_turn', description: 'd', referenceId: 'r1' })
    const call = calls[0]!
    expect(call.method).toBe('POST')
    expect(call.headers.get('Authorization')).toBe('Bearer svc-token')
    expect(call.headers.get('X-Service-Name')).toBe('my-agent')
    expect(call.body).toEqual({
      userId: 'pu_1',
      amount: 0.42,
      type: 'agent_turn',
      product: 'my-agent',
      description: 'd',
      referenceId: 'r1',
    })
  })

  it('deduct fails loud when the service token resolves empty', async () => {
    const f = fakeFetch({ '/v1/billing/deduct': { body: {} } })
    const http = createPlatformBillingHttp({
      baseUrl: 'https://id.example',
      serviceToken: () => '',
      productSlug: 'my-agent',
      fetchImpl: f.impl,
    })
    await expect(
      http.deduct({ platformUserId: 'p', amountUsd: 1, type: 't', description: 'd', referenceId: 'r' }),
    ).rejects.toThrow('service token is required')
    expect(f.calls).toHaveLength(0)
  })

  it('non-OK responses throw a typed error with the platform detail', async () => {
    const { http } = billingHttp({
      '/v1/billing/balance': { status: 403, body: { error: { message: 'forbidden by policy' } } },
    })
    const err = await http.getBalance('k').catch((e: unknown) => e)
    expect(isPlatformBillingHttpError(err)).toBe(true)
    expect((err as Error).message).toBe('Platform request failed (403): forbidden by policy')
  })

  it('billingUrl points at the platform billing surface', () => {
    const { http } = billingHttp({})
    expect(http.billingUrl()).toBe('https://id.example/app/billing')
  })
})

describe('readTangleTierState', () => {
  it('fails closed to free/zero for a missing key', async () => {
    const neverHttp = {} as PlatformBillingHttp
    expect(await readTangleTierState(neverHttp, null)).toEqual({
      tier: 'free',
      subscriptionStatus: null,
      remainingBalanceUsd: 0,
      lifetimeSpentUsd: 0,
      concurrency: 1,
      overageAllowed: false,
    })
  })

  it('projects a paid tier onto the policy', async () => {
    const { http } = billingHttp({
      '/v1/plans/current': { body: { success: true, data: { subscription: { plan: 'enterprise', status: 'active' } } } },
      '/v1/billing/balance': { body: { success: true, data: { balance: 100, lifetimeSpent: 5 } } },
    })
    const state = await readTangleTierState(http, 'k')
    expect(state.tier).toBe('enterprise')
    expect(state.overageAllowed).toBe(true)
    expect(state.concurrency).toBe(Number.POSITIVE_INFINITY)
    expect(state.remainingBalanceUsd).toBe(100)
  })
})

describe('createTanglePlatformBillingClient through createPlatformBalanceManager', () => {
  it('drives the /billing seam end-to-end', async () => {
    const { http } = billingHttp({
      '/v1/plans/current': { body: { success: true, data: { subscription: { plan: 'pro', status: 'active' } } } },
      '/v1/billing/balance': { body: { success: true, data: { balance: 7, lifetimeSpent: 2 } } },
      '/v1/billing/usage': { body: { success: true, data: [{ product: 'my-agent', totalSpent: 2, count: 4 }] } },
    })
    const client = createTanglePlatformBillingClient(http, {
      resolveIdentity: async (userId) => ({ platformUserId: `p_${userId}`, apiKey: 'sk-user-key' }),
    })
    const manager = createPlatformBalanceManager({
      client,
      planLimits: {
        free: { monthlyBalanceUsd: 0, concurrency: 1, overageAllowed: false },
        pro: { monthlyBalanceUsd: 50, concurrency: 10, overageAllowed: true },
        enterprise: { monthlyBalanceUsd: 500, concurrency: 100, overageAllowed: true },
      },
      freePlan: 'free',
      productSlug: 'my-agent',
    })
    const { allowed, state } = await manager.canStartBillableTurn('u_1')
    expect(allowed).toBe(true)
    expect(state.plan).toBe('pro')
    expect(state.remainingBalanceUsd).toBe(7)
    expect(await manager.getProductUsage('u_1')).toEqual({ spentUsd: 2, transactionCount: 4 })
  })
})

// ── Guards ──────────────────────────────────────────────────────────────────

describe('createAuthGuard', () => {
  const session = { user: { id: 'u_1', email: 'a@b.co' } }
  const guard = createAuthGuard({ getSession: async (r) => (r.headers.get('cookie') ? session : null) })
  const authed = () => new Request('https://my.app/x', { headers: { cookie: 's=1' } })
  const anon = () => new Request('https://my.app/x')

  it('returns the session when authenticated', async () => {
    expect(await guard.requireUser(authed())).toBe(session)
    expect(await guard.getOptionalSession(anon())).toBeNull()
  })

  it('requireUser throws a 302 redirect to the login path', async () => {
    const thrown = await guard.requireUser(anon()).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(Response)
    expect((thrown as Response).status).toBe(302)
    expect((thrown as Response).headers.get('Location')).toBe('/login')
  })

  it('requireApiUser throws a JSON 401', async () => {
    const thrown = (await guard.requireApiUser(anon()).catch((e: unknown) => e)) as Response
    expect(thrown.status).toBe(401)
    expect(await thrown.json()).toEqual({ error: 'Unauthorized', code: 'auth.unauthenticated' })
  })
})

describe('parseAdminEmails + createAdminGuard', () => {
  it('parses comma/whitespace lists case-insensitively', () => {
    expect(parseAdminEmails(' A@b.Co, c@d.io\n e@f.gg ')).toEqual(['a@b.co', 'c@d.io', 'e@f.gg'])
    expect(parseAdminEmails(undefined)).toEqual([])
  })

  const mkGuard = (allowed: string[]) =>
    createAdminGuard({
      requireUser: async () => ({ user: { email: 'A@b.Co' } }),
      emailOf: (s) => s.user.email,
      allowedEmails: () => allowed,
    })

  it('404s on an empty allowlist and for non-listed emails', async () => {
    for (const guard of [mkGuard([]), mkGuard(['other@x.io'])]) {
      const thrown = (await guard(new Request('https://my.app/admin')).catch((e: unknown) => e)) as Response
      expect(thrown.status).toBe(404)
    }
  })

  it('passes listed emails case-insensitively', async () => {
    const session = await mkGuard(['a@b.co'])(new Request('https://my.app/admin'))
    expect(session.user.email).toBe('A@b.Co')
  })
})

describe('assertBillableBalance', () => {
  const enforced = { APP_ENV: 'production' }

  it('throws 402 with the stable code and merged body for a broke free tier', async () => {
    let thrown: unknown
    try {
      assertBillableBalance(
        { overageAllowed: false, remainingBalanceUsd: 0 },
        { env: enforced, errorBody: { organizationId: 'org_1' } },
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Response)
    expect((thrown as Response).status).toBe(402)
    expect(await (thrown as Response).json()).toEqual({
      error: 'Add balance or upgrade your plan to invoke this agent.',
      code: 'billing.balance_required',
      organizationId: 'org_1',
    })
  })

  it('errorBody extras cannot shadow the stable error/code contract', async () => {
    let thrown: unknown
    try {
      assertBillableBalance(
        { overageAllowed: false, remainingBalanceUsd: 0 },
        { env: enforced, errorBody: { code: 'spoofed', error: 'spoofed', extra: 1 } },
      )
    } catch (e) {
      thrown = e
    }
    const body = await (thrown as Response).json()
    expect(body).toEqual({
      error: 'Add balance or upgrade your plan to invoke this agent.',
      code: 'billing.balance_required',
      extra: 1,
    })
  })

  it('passes for overage tiers, positive balances, and disabled enforcement', () => {
    assertBillableBalance({ overageAllowed: true, remainingBalanceUsd: 0 }, { env: enforced })
    assertBillableBalance({ overageAllowed: false, remainingBalanceUsd: 5 }, { env: enforced })
    assertBillableBalance(
      { overageAllowed: false, remainingBalanceUsd: 0 },
      { env: { APP_ENV: 'production', MY_FLAG: 'disabled' }, enforcementEnvVar: 'MY_FLAG' },
    )
    assertBillableBalance({ overageAllowed: false, remainingBalanceUsd: 0 }, { env: { APP_ENV: 'development' } })
  })
})

describe('createBetterAuthSessionCookieMinter', () => {
  const mintArgs = { token: 'tok_1', expiresAt: new Date(0), ttlSeconds: 2_592_000, secure: true }
  const authWith = (name: string, attributes: Record<string, unknown> = {}) => ({
    $context: Promise.resolve({
      secret: AUTH_SECRET,
      authCookies: {
        sessionToken: {
          name,
          attributes: { httpOnly: true, sameSite: 'lax', secure: true, path: '/', ...attributes },
        },
      },
    }),
  })

  it("mints better-auth's cookie verbatim: its name, its attributes, the signed value", async () => {
    const mint = createBetterAuthSessionCookieMinter(authWith('__Secure-myapp.session_token'))
    const cookies = await mint(mintArgs)

    const [session] = cookies
    expect(session).toMatch(/^__Secure-myapp\.session_token=/)
    const value = session!.split(';')[0]!.split(/=(.*)/s)[1]!
    expect(value).toBe(encodeURIComponent(await signSessionCookieValue('tok_1', AUTH_SECRET)))
    expect(session).toContain('Path=/')
    expect(session).toContain('HttpOnly')
    expect(session).toContain('SameSite=Lax')
    expect(session).toContain('Max-Age=2592000')
    expect(session).toContain('Secure')
  })

  it('expires the legacy raw cookie when the better-auth name differs', async () => {
    const mint = createBetterAuthSessionCookieMinter(authWith('__Secure-myapp.session_token'))
    const cookies = await mint(mintArgs)

    expect(cookies).toHaveLength(2)
    expect(cookies[1]).toMatch(/^better-auth\.session_token=;/)
    expect(cookies[1]).toContain('Max-Age=0')
  })

  it('sets no legacy expiry when the name IS the raw default (and warns)', async () => {
    const warn = vi.fn()
    const mint = createBetterAuthSessionCookieMinter(authWith('better-auth.session_token', { secure: false }), {
      warn,
    })
    const cookies = await mint(mintArgs)

    expect(cookies).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("warns on better-auth's default cookie name — the platform's domain-wide cookie shadows it", async () => {
    const warn = vi.fn()
    const mint = createBetterAuthSessionCookieMinter(authWith('__Secure-better-auth.session_token'), { warn })
    await mint(mintArgs)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('cookiePrefix')
  })

  it('does not warn on an app-prefixed name', async () => {
    const warn = vi.fn()
    const mint = createBetterAuthSessionCookieMinter(authWith('__Secure-myapp.session_token'), { warn })
    await mint(mintArgs)

    expect(warn).not.toHaveBeenCalled()
  })

  it('refuses a domain-scoped session cookie', async () => {
    const mint = createBetterAuthSessionCookieMinter(
      authWith('__Secure-myapp.session_token', { domain: '.tangle.tools' }),
    )
    await expect(mint(mintArgs)).rejects.toThrow(/domain-scoped/)
  })
})

describe('guardResolution', () => {
  it('adapts a thrown-Response guard to { ok: false, response }', async () => {
    const denied = Response.json({ error: 'Unauthorized' }, { status: 401 })
    const result = await guardResolution(async () => {
      throw denied
    })
    expect(result).toEqual({ ok: false, response: denied })
  })

  it('wraps a successful guard value and rethrows non-Response errors', async () => {
    const session = { user: { id: 'u1' } }
    expect(await guardResolution(async () => session)).toEqual({ ok: true, value: session })
    await expect(guardResolution(async () => { throw new Error('db down') })).rejects.toThrow('db down')
  })
})
