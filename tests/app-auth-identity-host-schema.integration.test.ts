import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import { createAppAuth, type AppAuth } from '../src/app-auth'
import {
  createD1TangleIdentityStore,
  TangleSsoAccountConflictError,
  type TangleIdentityD1Like,
  type TangleIdentityD1Statement,
  type TangleIdentityHostSchema,
  type TangleIdentitySsoAuthClient,
} from '../src/platform'

const HOST_SCHEMA = {
  user: {
    table: 'users',
    columns: { id: 'id', name: 'name', email: 'email', emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' },
  },
  session: {
    table: 'sessions',
    columns: { id: 'id', userId: 'user_id', token: 'token', expiresAt: 'expires_at', ipAddress: 'ip_address', userAgent: 'user_agent', createdAt: 'created_at', updatedAt: 'updated_at' },
  },
  account: {
    table: 'accounts',
    columns: { id: 'id', userId: 'user_id', accountId: 'account_id', providerId: 'provider_id', createdAt: 'created_at', updatedAt: 'updated_at' },
  },
} satisfies TangleIdentityHostSchema

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
  issuer: text('issuer'),
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

function d1(sqlite: Database.Database): TangleIdentityD1Like {
  const statement = (query: string, values: unknown[] = []): TangleIdentityD1Statement & { exec(): { changes: number } } => ({
    bind: (...next: unknown[]) => statement(query, next),
    first: async <T>() => (sqlite.prepare(query).get(...(values as never[])) as T | undefined) ?? null,
    all: async <T>() => ({ results: sqlite.prepare(query).all(...(values as never[])) as T[] }),
    run: async () => ({ meta: { changes: sqlite.prepare(query).run(...(values as never[])).changes } }),
    exec: () => ({ changes: sqlite.prepare(query).run(...(values as never[])).changes }),
  })
  return {
    prepare: query => statement(query),
    batch: async statements => sqlite.transaction(() =>
      statements.map(value => ({ meta: (value as ReturnType<typeof statement>).exec() })))(),
  }
}

function fixture(platformUser: { id: string; email: string; name?: string | null }) {
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
      id TEXT PRIMARY KEY, issuer TEXT, account_id TEXT NOT NULL, provider_id TEXT NOT NULL, user_id TEXT NOT NULL,
      access_token TEXT, refresh_token TEXT, id_token TEXT,
      access_token_expires_at INTEGER, refresh_token_expires_at INTEGER,
      scope TEXT, password TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE verifications (
      id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL,
      expires_at INTEGER NOT NULL, created_at INTEGER, updated_at INTEGER
    );
    CREATE UNIQUE INDEX accounts_tangle_platform_user ON accounts(account_id) WHERE provider_id = 'tangle';
    CREATE UNIQUE INDEX accounts_tangle_user ON accounts(user_id) WHERE provider_id = 'tangle';
  `)
  const store = createD1TangleIdentityStore({ db: d1(sqlite), hostSchema: HOST_SCHEMA })
  const client: TangleIdentitySsoAuthClient = {
    authorizeUrl: ({ state }) => `http://127.0.0.1:4100/cross-site/authorize?state=${encodeURIComponent(state)}`,
    exchange: async () => ({ kind: 'identity', emailVerified: true, user: { name: null, ...platformUser } }),
  }
  const baseURL = 'http://127.0.0.1:8790'
  const app = createAppAuth({
    appName: 'Host schema integration', baseURL, secret: 'identity-host-schema-test-secret-32-bytes',
    db: drizzle(sqlite, { schema: { users, sessions, accounts, verifications } }),
    schema: { users, sessions, accounts, verifications },
    emailAndPassword: false, sessionCookieCacheSeconds: false,
    sso: { protocol: 'identity', client, store, callbackUrl: `${baseURL}/auth/tangle/callback`, secureCookies: false },
  })
  return { sqlite, store, app, baseURL }
}

async function callback(app: AppAuth, baseURL: string) {
  const started = await app.sso!.start(new Request(`${baseURL}/auth/tangle/start?redirect=/app`))
  const stateCookie = started.headers.getSetCookie().find(value => value.startsWith('tangle_sso_state='))!.split(';')[0]!
  const state = new URL(started.headers.get('Location')!).searchParams.get('state')!
  const response = await app.sso!.callback(new Request(`${baseURL}/auth/tangle/callback?code=c&state=${encodeURIComponent(state)}`, {
    headers: { cookie: stateCookie },
  }))
  return {
    response,
    cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '),
  }
}

function rows(sqlite: Database.Database) {
  return {
    users: sqlite.prepare('SELECT id, email, email_verified AS emailVerified FROM users').all(),
    sessions: sqlite.prepare('SELECT token, user_id AS userId FROM sessions').all(),
    links: sqlite.prepare("SELECT user_id AS userId, account_id AS accountId FROM accounts WHERE provider_id = 'tangle'").all(),
  }
}

describe('createAppAuth identity with a mapped Better Auth host schema', () => {
  it('persists a real identity callback and resolves its exact session against plural snake-case tables', async () => {
    const { sqlite, app, baseURL } = fixture({ id: 'platform-new', email: ' New@Example.test ' })
    try {
      const result = await callback(app, baseURL)
      expect(result.response.status).toBe(302)
      expect(result.response.headers.get('Location')).toBe('/app')
      const session = await app.getSession(new Request(`${baseURL}/app`, { headers: { cookie: result.cookie } }))
      expect(session?.user.email).toBe('new@example.test')
      expect(rows(sqlite)).toEqual({
        users: [{ id: session!.user.id, email: 'new@example.test', emailVerified: 1 }],
        sessions: [{ token: session!.session.token, userId: session!.user.id }],
        links: [{ userId: session!.user.id, accountId: 'platform-new' }],
      })
    } finally { sqlite.close() }
  })

  it('enforces exact-session linking and one link per local and platform user through public store methods', async () => {
    const { sqlite, store, app, baseURL } = fixture({ id: 'platform-owner', email: 'owner@example.test' })
    try {
      const result = await callback(app, baseURL)
      const session = await app.getSession(new Request(`${baseURL}/app`, { headers: { cookie: result.cookie } }))
      const ownerId = session!.user.id
      const ownerToken = session!.session.token
      sqlite.prepare("INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ('other', 'Other', 'other@example.test', 1, unixepoch(), unixepoch())").run()
      const { token: otherToken } = await store.createSession({
        userId: 'other', expiresAt: new Date(Date.now() + 60_000), ipAddress: null, userAgent: null,
      })

      await expect(store.saveTangleLink({ userId: ownerId, sessionToken: otherToken, tangleUserId: 'platform-owner', email: 'owner@example.test', name: null }))
        .rejects.toBeInstanceOf(TangleSsoAccountConflictError)
      await expect(store.saveTangleLink({ userId: 'other', sessionToken: otherToken, tangleUserId: 'platform-owner', email: 'other@example.test', name: null }))
        .rejects.toBeInstanceOf(TangleSsoAccountConflictError)
      await expect(store.saveTangleLink({ userId: ownerId, sessionToken: ownerToken, tangleUserId: 'platform-other', email: 'owner@example.test', name: null }))
        .rejects.toBeInstanceOf(TangleSsoAccountConflictError)
      await store.saveTangleLink({ userId: ownerId, sessionToken: ownerToken, tangleUserId: 'platform-owner', email: 'owner@example.test', name: null })

      expect(rows(sqlite).links).toEqual([{ userId: ownerId, accountId: 'platform-owner' }])
      expect(rows(sqlite).sessions).toHaveLength(2)
    } finally { sqlite.close() }
  })
})
