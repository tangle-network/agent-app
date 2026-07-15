/**
 * `createAppAuth` contract tests against REAL better-auth instances. The
 * memory adapter drives the flows (per the signed-cookie contract: better-auth
 * only accepts HMAC-signed, `__Secure-`-prefixed-on-https session cookies, so
 * every round-trip here proves the full sign → set-cookie → getSession path),
 * and one drizzle + better-sqlite3 case proves the `db`/`schema` wiring the
 * products actually deploy with.
 */

import { describe, it, expect } from 'vitest'
import { memoryAdapter } from 'better-auth/adapters/memory'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import {
  createAppAuth,
  type AppAuth,
  type AppAuthConfig,
  type AppAuthEmailClient,
} from '../src/app-auth/index'
import type { TangleSsoAccountStore, TangleSsoAuthClient } from '../src/platform/index'

const SECRET = 'app-auth-factory-contract-test-secret'

function memoryDatabase() {
  return memoryAdapter({ user: [], session: [], account: [], verification: [] })
}

function makeAppAuth(overrides: Partial<AppAuthConfig> = {}): AppAuth {
  return createAppAuth({
    appName: 'My App',
    baseURL: 'http://localhost:3000',
    secret: SECRET,
    database: memoryDatabase(),
    ...overrides,
  })
}

async function signUp(appAuth: AppAuth, baseURL: string, email: string): Promise<Response> {
  return appAuth.auth.handler(
    new Request(`${baseURL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseURL },
      body: JSON.stringify({ email, password: 'correct-horse-battery', name: 'Ada' }),
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

function requestWithCookies(url: string, cookie: string): Request {
  return new Request(url, { headers: { cookie } })
}

describe('createAppAuth: sign-up/sign-in round-trip', () => {
  it('sign-up sets a session cookie that resolves through getSession and the guards', async () => {
    const appAuth = makeAppAuth()
    const res = await signUp(appAuth, 'http://localhost:3000', 'ada@example.com')
    expect(res.status).toBe(200)

    // Default cookiePrefix is the slugified appName ('My App' → 'my-app').
    const sessionCookie = res.headers.getSetCookie().find((c) => c.startsWith('my-app.session_token='))
    expect(sessionCookie).toBeDefined()

    const request = requestWithCookies('http://localhost:3000/app', cookieHeaderFrom(res))
    const session = await appAuth.getSession(request)
    expect(session?.user.email).toBe('ada@example.com')

    const viaGuard = await appAuth.requireApiUser(request)
    expect(viaGuard.user.email).toBe('ada@example.com')
  })

  it('sign-in after sign-up round-trips through auth.api.getSession', async () => {
    const appAuth = makeAppAuth()
    await signUp(appAuth, 'http://localhost:3000', 'grace@example.com')

    const signIn = await appAuth.auth.handler(
      new Request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ email: 'grace@example.com', password: 'correct-horse-battery' }),
      }),
    )
    expect(signIn.status).toBe(200)

    const session = await appAuth.getSession(
      requestWithCookies('http://localhost:3000/app', cookieHeaderFrom(signIn)),
    )
    expect(session?.user.email).toBe('grace@example.com')
  })

  it('https baseURL mints the __Secure--prefixed cookie', async () => {
    const appAuth = makeAppAuth({ baseURL: 'https://my.app', trustedOrigins: ['https://my.app'] })
    const res = await signUp(appAuth, 'https://my.app', 'ada@example.com')
    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie().some((c) => c.startsWith('__Secure-my-app.session_token='))).toBe(true)
  })
})

describe('createAppAuth: guards', () => {
  it('requireApiUser throws JSON 401 without a session', async () => {
    const appAuth = makeAppAuth()
    const bare = new Request('http://localhost:3000/api/thing')
    const thrown = await appAuth.requireApiUser(bare).then(
      () => null,
      (e: unknown) => e,
    )
    expect(thrown).toBeInstanceOf(Response)
    const res = thrown as Response
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized', code: 'auth.unauthenticated' })
  })

  it('requireUser throws a 302 to the configured loginPath', async () => {
    const appAuth = makeAppAuth({ loginPath: '/signin' })
    const thrown = await appAuth.requireUser(new Request('http://localhost:3000/app')).then(
      () => null,
      (e: unknown) => e,
    )
    expect(thrown).toBeInstanceOf(Response)
    const res = thrown as Response
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/signin')
  })

  it('getOptionalSession returns null (not a throw) without a session', async () => {
    const appAuth = makeAppAuth()
    expect(await appAuth.getOptionalSession(new Request('http://localhost:3000/app'))).toBeNull()
  })
})

describe('createAppAuth: social providers (env-shaped)', () => {
  it('registers a provider only when both env values are present', () => {
    const appAuth = makeAppAuth({
      social: {
        github: { clientId: 'gh-id', clientSecret: 'gh-secret' },
        // Half-configured (secret unset in env) → provider must be absent.
        google: { clientId: 'g-id', clientSecret: undefined },
      },
    })
    expect(appAuth.auth.options.socialProviders?.github).toMatchObject({
      clientId: 'gh-id',
      clientSecret: 'gh-secret',
    })
    expect(appAuth.auth.options.socialProviders?.google).toBeUndefined()
  })

  it('omits socialProviders entirely when no env is supplied', () => {
    const appAuth = makeAppAuth({ social: { github: {}, google: {} } })
    expect(appAuth.auth.options.socialProviders).toBeUndefined()
  })
})

describe('createAppAuth: email wiring', () => {
  function captureClient() {
    const sent: Array<{ from: string; to: string; subject: string; html: string }> = []
    const client: AppAuthEmailClient = {
      emails: {
        send: async (message) => {
          sent.push(message)
          return { data: { id: 'em_1' }, error: null }
        },
      },
    }
    return { sent, client }
  }

  it('password reset sends through the product client with the reset link', async () => {
    const { sent, client } = captureClient()
    const appAuth = makeAppAuth({
      email: { resend: client, from: 'My App <noreply@my.app>' },
    })
    await signUp(appAuth, 'http://localhost:3000', 'ada@example.com')

    const res = await appAuth.auth.handler(
      new Request('http://localhost:3000/api/auth/request-password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ email: 'ada@example.com', redirectTo: '/reset' }),
      }),
    )
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ from: 'My App <noreply@my.app>', to: 'ada@example.com', subject: 'Reset your password' })
    expect(sent[0]!.html).toContain('http://localhost:3000/api/auth/reset-password/')
  })

  it('verifyOnSignUp sends the verification email with the appName subject', async () => {
    const { sent, client } = captureClient()
    const appAuth = makeAppAuth({
      email: { resend: client, from: 'My App <noreply@my.app>', verifyOnSignUp: true },
    })
    const res = await signUp(appAuth, 'http://localhost:3000', 'ada@example.com')
    expect(res.status).toBe(200)
    expect(sent.some((m) => m.subject === 'Verify your My App email')).toBe(true)
  })

  it('a lazy getter returning null warns and skips instead of crashing sign-up', async () => {
    const warnings: string[] = []
    const appAuth = makeAppAuth({
      email: {
        resend: () => null,
        from: 'My App <noreply@my.app>',
        verifyOnSignUp: true,
        warn: (m) => warnings.push(m),
      },
    })
    const res = await signUp(appAuth, 'http://localhost:3000', 'ada@example.com')
    expect(res.status).toBe(200)
    expect(warnings.some((w) => w.includes('verification email not sent'))).toBe(true)
  })

  it('a Resend-style { error } result fails loud', async () => {
    const failing: AppAuthEmailClient = {
      emails: { send: async () => ({ data: null, error: { message: 'domain not verified' } }) },
    }
    const appAuth = makeAppAuth({ email: { resend: failing, from: 'My App <noreply@my.app>' } })
    const send = appAuth.auth.options.emailAndPassword?.sendResetPassword
    expect(send).toBeDefined()
    await expect(
      send!(
        {
          user: {
            id: 'u1',
            email: 'ada@example.com',
            name: 'Ada',
            emailVerified: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          url: 'http://localhost:3000/reset?token=t',
          token: 't',
        },
        undefined,
      ),
    ).rejects.toThrow(/domain not verified/)
  })
})

describe('createAppAuth: Tangle SSO wiring', () => {
  const ssoClient: TangleSsoAuthClient = {
    authorizeUrl: ({ state }) => `https://id.tangle.tools/cross-site/authorize?state=${encodeURIComponent(state)}`,
    exchange: async () => ({ apiKey: 'sk-tan-key', user: { id: 'tu_1', email: 'ada@example.com', name: 'Ada' } }),
  }

  /** Store persisting through better-auth's own adapter — the rows getSession
   *  will read are exactly what a product DB would hold. */
  function adapterBackedStore(appAuth: AppAuth): TangleSsoAccountStore {
    return {
      async upsertUserByEmail({ email, name }) {
        const ctx = await appAuth.auth.$context
        const user = await ctx.adapter.create<{ id: string }>({
          model: 'user',
          data: { email, name: name ?? email, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
        })
        return { userId: user.id }
      },
      async createSession({ userId, expiresAt, ipAddress, userAgent }) {
        const ctx = await appAuth.auth.$context
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

  it('SSO callback mints a signed, app-prefixed cookie that getSession accepts', async () => {
    const store: { current: TangleSsoAccountStore | null } = { current: null }
    const appAuth = makeAppAuth({
      appName: 'My App',
      baseURL: 'https://my.app',
      sso: {
        client: ssoClient,
        store: {
          upsertUserByEmail: (i) => store.current!.upsertUserByEmail(i),
          createSession: (i) => store.current!.createSession(i),
          saveTangleLink: (i) => store.current!.saveTangleLink(i),
        },
        callbackUrl: 'https://my.app/auth/tangle/callback',
      },
    })
    store.current = adapterBackedStore(appAuth)
    expect(appAuth.sso).not.toBeNull()

    const startRes = await appAuth.sso!.start(new Request('https://my.app/auth/tangle/start?redirect=/app'))
    expect(startRes.status).toBe(302)
    const stateCookie = startRes.headers
      .getSetCookie()
      .find((c) => c.startsWith('tangle_sso_state='))!
      .split(';')[0]!
    const state = new URL(startRes.headers.get('Location')!).searchParams.get('state')!

    const callbackRes = await appAuth.sso!.callback(
      new Request(`https://my.app/auth/tangle/callback?code=c1&state=${encodeURIComponent(state)}`, {
        headers: { cookie: stateCookie },
      }),
    )
    expect(callbackRes.status).toBe(302)
    expect(callbackRes.headers.get('Location')).toBe('/app')

    // better-auth's own name (prefix included) with a signed value…
    const sessionSetCookie = callbackRes.headers
      .getSetCookie()
      .find((c) => c.startsWith('__Secure-my-app.session_token='))
    expect(sessionSetCookie).toBeDefined()

    // …that better-auth itself resolves back to the SSO user.
    const session = await appAuth.getSession(
      requestWithCookies('https://my.app/app', cookieHeaderFrom(callbackRes)),
    )
    expect(session?.user.email).toBe('ada@example.com')
  })

  it('sso without a resolvable state secret fails loud at construction', () => {
    expect(() =>
      createAppAuth({
        appName: 'My App',
        baseURL: 'https://my.app',
        database: memoryDatabase(),
        sso: {
          client: ssoClient,
          store: {} as TangleSsoAccountStore,
          callbackUrl: 'https://my.app/auth/tangle/callback',
        },
      }),
    ).toThrow(/secret/)
  })
})

describe('createAppAuth: drizzle db/schema path', () => {
  const users = sqliteTable('users', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: integer('email_verified', { mode: 'boolean' }).notNull(),
    image: text('image'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  })
  const sessions = sqliteTable('sessions', {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id').notNull(),
  })
  const accounts = sqliteTable('accounts', {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  })
  const verifications = sqliteTable('verifications', {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
  })

  function sqliteDb() {
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
        email_verified INTEGER NOT NULL, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, token TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        ip_address TEXT, user_agent TEXT, user_id TEXT NOT NULL
      );
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL, user_id TEXT NOT NULL,
        access_token TEXT, refresh_token TEXT, id_token TEXT,
        access_token_expires_at INTEGER, refresh_token_expires_at INTEGER,
        scope TEXT, password TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE verifications (
        id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL,
        expires_at INTEGER NOT NULL, created_at INTEGER, updated_at INTEGER
      );
    `)
    return drizzle(sqlite)
  }

  it('db + schema wire the drizzle adapter: sign-up round-trips through real tables', async () => {
    const appAuth = createAppAuth({
      appName: 'Legal Agent',
      baseURL: 'http://localhost:3000',
      secret: SECRET,
      db: sqliteDb(),
      schema: { users, sessions, accounts, verifications },
    })

    const res = await signUp(appAuth, 'http://localhost:3000', 'ada@example.com')
    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie().some((c) => c.startsWith('legal-agent.session_token='))).toBe(true)

    const session = await appAuth.getSession(
      requestWithCookies('http://localhost:3000/app', cookieHeaderFrom(res)),
    )
    expect(session?.user.email).toBe('ada@example.com')
  })

  it('fails loud when neither database nor db+schema is provided', () => {
    expect(() => createAppAuth({ appName: 'My App', baseURL: 'http://localhost:3000', secret: SECRET })).toThrow(
      /requires a database/,
    )
  })
})
