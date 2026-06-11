/**
 * Contract test against a REAL better-auth instance: the Set-Cookie the SSO
 * callback emits must round-trip through `auth.api.getSession`. better-auth
 * reads sessions via better-call's `getSignedCookie` — `__Secure-`-prefixed
 * name on https deployments, value `<token>.<44-char padded base64
 * HMAC-SHA256>` — so a raw unsigned cookie (the pre-seam behavior) always
 * yields a null session. The negative-control test pins that failure class.
 */

import { describe, it, expect } from 'vitest'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import {
  createBetterAuthSessionCookieMinter,
  createTangleSsoHandlers,
  type TangleSsoAccountStore,
  type TangleSsoAuthClient,
  type TangleSsoHandlers,
  type TangleSsoSessionCookieArgs,
} from '../src/platform/index'

const AUTH_SECRET = 'better-auth-secret-for-contract-test'
const STATE_SECRET = 'state-secret-distinct-from-auth-secret'

function makeAuth(baseURL: string, cookiePrefix?: string) {
  return betterAuth({
    baseURL,
    secret: AUTH_SECRET,
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    ...(cookiePrefix ? { advanced: { cookiePrefix } } : {}),
  })
}

type TestAuth = ReturnType<typeof makeAuth>

/** Store that persists through better-auth's own adapter, so `getSession`
 *  sees exactly the rows a product DB would hold. */
function betterAuthBackedStore(auth: TestAuth): TangleSsoAccountStore {
  return {
    async upsertUserByEmail({ email, name }) {
      const ctx = await auth.$context
      const user = await ctx.adapter.create<{ id: string }>({
        model: 'user',
        data: { email, name: name ?? email, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
      })
      return { userId: user.id }
    },
    async createSession({ userId, expiresAt, ipAddress, userAgent }) {
      const ctx = await auth.$context
      const token = crypto.randomUUID().replaceAll('-', '')
      await ctx.adapter.create({
        model: 'session',
        data: { token, userId, expiresAt, ipAddress, userAgent, createdAt: new Date(), updatedAt: new Date() },
      })
      return { token }
    },
    async saveTangleLink() {},
  }
}

const ssoClient: TangleSsoAuthClient = {
  authorizeUrl: ({ state }) => `https://id.example/cross-site/authorize?state=${encodeURIComponent(state)}`,
  exchange: async () => ({ apiKey: 'sk-tan-key', user: { id: 'tu_1', email: 'ada@example.com', name: 'Ada' } }),
}

async function loginThroughCallback(handlers: TangleSsoHandlers, origin: string): Promise<Response> {
  const startRes = await handlers.start(new Request(`${origin}/auth/tangle/start?redirect=/app`))
  const stateCookie = startRes.headers
    .getSetCookie()
    .find((c) => c.startsWith('tangle_sso_state='))!
    .split(';')[0]!
  const state = new URL(startRes.headers.get('Location')!).searchParams.get('state')!
  return handlers.callback(
    new Request(`${origin}/auth/tangle/callback?code=c1&state=${encodeURIComponent(state)}`, {
      headers: { cookie: stateCookie },
    }),
  )
}

/** Browser behavior: echo every Set-Cookie pair back verbatim. */
function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .join('; ')
}

async function getSessionWith(auth: TestAuth, cookie: string) {
  return auth.api.getSession({ headers: new Headers({ cookie }) })
}

describe('SSO session cookie ↔ better-auth contract', () => {
  it('secure mode: __Secure--prefixed signed cookie round-trips through auth.api.getSession', async () => {
    const auth = makeAuth('https://my.app')
    const handlers = createTangleSsoHandlers({
      auth: ssoClient,
      store: betterAuthBackedStore(auth),
      stateSecret: STATE_SECRET,
      sessionCookieSecret: AUTH_SECRET,
      callbackUrl: 'https://my.app/auth/tangle/callback',
      stateCookieName: 'tangle_sso_state',
      secureCookies: true,
    })

    const res = await loginThroughCallback(handlers, 'https://my.app')
    expect(res.status).toBe(302)

    const sessionSetCookie = res.headers.getSetCookie().find((c) => c.startsWith('__Secure-better-auth.session_token='))
    expect(sessionSetCookie).toBeDefined()
    expect(sessionSetCookie).toContain('Secure')
    // better-call's getSignedCookie contract: 44-char standard base64
    // signature with trailing '=' (percent-encoded as %3D on the wire).
    const value = decodeURIComponent(sessionSetCookie!.split(';')[0]!.split('=').slice(1).join('='))
    const signature = value.slice(value.lastIndexOf('.') + 1)
    expect(signature).toHaveLength(44)
    expect(signature.endsWith('=')).toBe(true)

    const session = await getSessionWith(auth, cookieHeaderFrom(res))
    expect(session?.user.email).toBe('ada@example.com')
  })

  it('insecure mode: unprefixed signed cookie round-trips', async () => {
    const auth = makeAuth('http://localhost:3000')
    const handlers = createTangleSsoHandlers({
      auth: ssoClient,
      store: betterAuthBackedStore(auth),
      stateSecret: STATE_SECRET,
      sessionCookieSecret: AUTH_SECRET,
      callbackUrl: 'http://localhost:3000/auth/tangle/callback',
      stateCookieName: 'tangle_sso_state',
      secureCookies: false,
    })

    const res = await loginThroughCallback(handlers, 'http://localhost:3000')
    const sessionSetCookie = res.headers.getSetCookie().find((c) => c.startsWith('better-auth.session_token='))
    expect(sessionSetCookie).toBeDefined()

    const session = await getSessionWith(auth, cookieHeaderFrom(res))
    expect(session?.user.email).toBe('ada@example.com')
  })

  it('createBetterAuthSessionCookieMinter: app-prefixed cookie round-trips through auth.api.getSession', async () => {
    const auth = makeAuth('https://my.app', 'myapp')
    const handlers = createTangleSsoHandlers({
      auth: ssoClient,
      store: betterAuthBackedStore(auth),
      stateSecret: STATE_SECRET,
      setSessionCookie: createBetterAuthSessionCookieMinter(auth),
      callbackUrl: 'https://my.app/auth/tangle/callback',
      stateCookieName: 'tangle_sso_state',
      secureCookies: true,
    })

    const res = await loginThroughCallback(handlers, 'https://my.app')
    expect(res.status).toBe(302)

    // better-auth's own prefixed name, minted by the helper.
    const sessionSetCookie = res.headers.getSetCookie().find((c) => c.startsWith('__Secure-myapp.session_token='))
    expect(sessionSetCookie).toBeDefined()
    // The default-name cookie appears only as an explicit expiry.
    for (const c of res.headers.getSetCookie().filter((v) => v.startsWith('better-auth.session_token='))) {
      expect(c).toContain('Max-Age=0')
    }

    const session = await getSessionWith(auth, cookieHeaderFrom(res))
    expect(session?.user.email).toBe('ada@example.com')
  })

  it('negative control: a raw unsigned cookie (the pre-seam behavior) reads back as a null session', async () => {
    const auth = makeAuth('http://localhost:3000')
    const store = betterAuthBackedStore(auth)
    const { userId } = await store.upsertUserByEmail({ email: 'ada@example.com', name: 'Ada', tangleUserId: 'tu_1' })
    const { token } = await store.createSession({
      userId,
      expiresAt: new Date(Date.now() + 86_400_000),
      ipAddress: null,
      userAgent: null,
    })

    // A well-formed (44-char, padded) but WRONG signature is rejected by the
    // HMAC verify itself — verification is active, not just shape-checked.
    const forgedSig = btoa(String.fromCharCode(...new Uint8Array(32)))
    const forged = await getSessionWith(
      auth,
      `better-auth.session_token=${encodeURIComponent(`${token}.${forgedSig}`)}`,
    )
    expect(forged).toBeNull()

    // …but the raw token — what the handler used to set — never resolves.
    const raw = await getSessionWith(auth, `better-auth.session_token=${token}`)
    expect(raw).toBeNull()
  })

  it('setSessionCookie seam: handler delegates entirely and sets no session cookie of its own', async () => {
    const seamCalls: TangleSsoSessionCookieArgs[] = []
    const auth = makeAuth('https://my.app')
    const handlers = createTangleSsoHandlers({
      auth: ssoClient,
      store: betterAuthBackedStore(auth),
      stateSecret: STATE_SECRET,
      setSessionCookie: (args) => {
        seamCalls.push(args)
        return [`my_session=${args.token}; Path=/; HttpOnly`, 'legacy_cookie=; Path=/; Max-Age=0']
      },
      callbackUrl: 'https://my.app/auth/tangle/callback',
      stateCookieName: 'tangle_sso_state',
      secureCookies: true,
      sessionTtlSeconds: 1234,
    })

    const res = await loginThroughCallback(handlers, 'https://my.app')
    const cookies = res.headers.getSetCookie()
    expect(cookies.some((c) => c.startsWith('my_session='))).toBe(true)
    expect(cookies.some((c) => c.startsWith('legacy_cookie='))).toBe(true)
    expect(cookies.some((c) => c.includes('better-auth.session_token'))).toBe(false)

    expect(seamCalls).toHaveLength(1)
    expect(seamCalls[0]).toMatchObject({ secure: true, ttlSeconds: 1234 })
    expect(seamCalls[0]!.token.length).toBeGreaterThan(0)
    expect(seamCalls[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('fails loud at construction when neither setSessionCookie nor sessionCookieSecret is provided', () => {
    expect(() =>
      createTangleSsoHandlers({
        auth: ssoClient,
        store: {} as TangleSsoAccountStore,
        stateSecret: STATE_SECRET,
        callbackUrl: 'https://my.app/cb',
        stateCookieName: 'tangle_sso_state',
        secureCookies: true,
      }),
    ).toThrow(/setSessionCookie or sessionCookieSecret/)
  })
})
