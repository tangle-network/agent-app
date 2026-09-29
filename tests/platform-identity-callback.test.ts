import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  createTangleSsoHandlers,
  type TangleIdentitySsoAccountStore,
  type TangleIdentitySsoAuthClient,
  type TangleSsoAuthClient,
} from '../src/platform/index'

const origin = 'http://127.0.0.1:8790'
const callbackUrl = `${origin}/auth/tangle/callback`
const validIdentity = {
  kind: 'identity' as const,
  emailVerified: true,
  user: { id: 'platform-user', email: 'member@example.test', name: 'Member' },
}
type ExchangeResult = Awaited<ReturnType<TangleIdentitySsoAuthClient['exchange']>>

function harness(overrides: {
  exchange?: () => Promise<unknown>
  setSessionCookie?: () => Promise<readonly string[]>
  saveTangleLink?: TangleIdentitySsoAccountStore['saveTangleLink']
} = {}) {
  const calls: string[] = []
  const sessions = new Set<string>()
  const auth: TangleIdentitySsoAuthClient = {
    authorizeUrl: ({ state, redirectUri }) => {
      const url = new URL('http://127.0.0.1:4100/cross-site/authorize')
      url.searchParams.set('state', state)
      url.searchParams.set('redirect', redirectUri ?? '')
      return url.toString()
    },
    exchange: async (code) => {
      calls.push(`exchange:${code}`)
      return (overrides.exchange ? await overrides.exchange() : validIdentity) as ExchangeResult
    },
  }
  const store: TangleIdentitySsoAccountStore = {
    resolveAccount: async () => {
      calls.push('resolve-account')
      return { kind: 'create' }
    },
    upsertUserByEmail: async () => {
      calls.push('upsert-user')
      return { userId: 'local-user' }
    },
    createSession: async () => {
      calls.push('create-session')
      sessions.add('local-session')
      return { token: 'local-session' }
    },
    saveTangleLink: async (input) => {
      calls.push('save-link')
      if (overrides.saveTangleLink) await overrides.saveTangleLink(input)
    },
    deleteSession: async ({ sessionToken }) => {
      calls.push(`delete-session:${sessionToken}`)
      sessions.delete(sessionToken)
    },
  }
  const handlers = createTangleSsoHandlers({
    protocol: 'identity', auth, store,
    stateSecret: 'identity-callback-test-state-secret-32-bytes',
    callbackUrl, stateCookieName: 'identity_state', secureCookies: false,
    setSessionCookie: overrides.setSessionCookie ?? (async () => {
      calls.push('mint-cookie')
      return ['local_session=local-session; Path=/; HttpOnly']
    }),
    log: () => {},
  })
  return { handlers, calls, sessions }
}

async function callback(handlers: ReturnType<typeof createTangleSsoHandlers>) {
  const started = await handlers.start(new Request(`${origin}/auth/tangle/start?redirect=/app`))
  const stateCookie = started.headers.getSetCookie().find(value => value.startsWith('identity_state='))!
    .split(';')[0]!
  const authorizationUrl = new URL(started.headers.get('Location')!)
  expect(authorizationUrl.searchParams.get('redirect')).toBe(callbackUrl)
  const state = authorizationUrl.searchParams.get('state')!
  return handlers.callback(new Request(`${callbackUrl}?code=controlled-code&state=${encodeURIComponent(state)}`, {
    headers: { cookie: stateCookie },
  }))
}

describe('identity-only SSO callback boundary', () => {
  it('does not accept a key-bearing auth client as an identity client', () => {
    expectTypeOf<TangleSsoAuthClient>().not.toExtend<TangleIdentitySsoAuthClient>()
  })

  it('uses the exact callback and publishes a session only for a keyless identity', async () => {
    const h = harness()
    const response = await callback(h.handlers)
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/app')
    expect(response.headers.getSetCookie().some(value => value.startsWith('local_session='))).toBe(true)
    expect(h.calls).toEqual([
      'exchange:controlled-code', 'resolve-account', 'upsert-user',
      'create-session', 'mint-cookie', 'save-link',
    ])
    expect(h.sessions.has('local-session')).toBe(true)
  })

  it.each([
    ['wrong result kind', { ...validIdentity, kind: 'key' }],
    ['key-bearing identity', { ...validIdentity, apiKey: 'unexpected-key' }],
    ['key id in identity', { ...validIdentity, keyId: 'unexpected-key-id' }],
    ['unverified email', { ...validIdentity, emailVerified: false }],
    ['blank platform user id', { ...validIdentity, user: { ...validIdentity.user, id: ' ' } }],
    ['blank email', { ...validIdentity, user: { ...validIdentity.user, email: ' ' } }],
  ])('rejects %s before touching a local account', async (_label, result) => {
    const h = harness({ exchange: async () => result })
    const response = await callback(h.handlers)
    expect(response.headers.get('Location')).toBe('/login?error=tangle_exchange_failed')
    expect(h.calls).toEqual(['exchange:controlled-code'])
    expect(h.sessions.size).toBe(0)
  })

  it('removes an unpublished session if cookie minting fails', async () => {
    const h = harness({ setSessionCookie: async () => { throw new Error('cookie mint failed') } })
    const response = await callback(h.handlers)
    expect(response.headers.get('Location')).toBe('/login?error=tangle_session_failed')
    expect(h.calls).toContain('delete-session:local-session')
    expect(h.calls).not.toContain('save-link')
    expect(h.sessions.size).toBe(0)
  })

  it('removes an unpublished session if link persistence fails', async () => {
    const h = harness({ saveTangleLink: async () => { throw new Error('link store failed') } })
    const response = await callback(h.handlers)
    expect(response.headers.get('Location')).toBe('/login?error=tangle_session_failed')
    expect(h.calls).toContain('delete-session:local-session')
    expect(h.sessions.size).toBe(0)
  })
})
