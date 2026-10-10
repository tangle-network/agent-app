import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  createD1TangleIdentityStore,
  TANGLE_IDENTITY_ACCOUNT_INDEXES_SQL,
  type D1TangleIdentityStoreOptions,
  type TangleIdentityD1Like,
  type TangleIdentityD1Statement,
} from './sso-identity-store'
import {
  createTangleSsoHandlers,
  TangleSsoAccountConflictError,
  type TangleIdentitySsoAccountStore,
  type TangleIdentitySsoAuthClient,
} from './sso'

/**
 * A real SQLite behind the narrow D1 shape: the invariants live in SQL guards
 * and unique indexes, so the assertions run against the engine D1 is built on.
 * `batch` is a transaction, as D1's is.
 */
function d1(sqlite: DatabaseSync): TangleIdentityD1Like {
  const statement = (query: string, values: unknown[] = []): TangleIdentityD1Statement & { exec(): { changes: number } } => ({
    bind: (...next: unknown[]) => statement(query, next),
    first: async <T>() => (sqlite.prepare(query).get(...(values as never[])) as T | undefined) ?? null,
    all: async <T>() => ({ results: sqlite.prepare(query).all(...(values as never[])) as T[] }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(query).run(...(values as never[])).changes) } }),
    exec: () => ({ changes: Number(sqlite.prepare(query).run(...(values as never[])).changes) }),
  })
  return {
    prepare: query => statement(query),
    batch: async statements => {
      sqlite.exec('BEGIN')
      try {
        const results = statements.map(s => ({ meta: (s as ReturnType<typeof statement>).exec() }))
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  }
}

/** Better Auth's default SQLite model, as Hospitality's 0000_auth.sql creates it. */
function database() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch()), updatedAt INTEGER NOT NULL DEFAULT (unixepoch()));
    CREATE TABLE session (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE, expiresAt INTEGER NOT NULL, ipAddress TEXT, userAgent TEXT,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch()), updatedAt INTEGER NOT NULL DEFAULT (unixepoch()));
    CREATE TABLE account (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      accountId TEXT NOT NULL, providerId TEXT NOT NULL, accessToken TEXT, refreshToken TEXT,
      accessTokenExpiresAt INTEGER, refreshTokenExpiresAt INTEGER, scope TEXT, idToken TEXT, password TEXT,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch()), updatedAt INTEGER NOT NULL DEFAULT (unixepoch()));
    CREATE TABLE tangle_identity (user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
      platform_user_id TEXT NOT NULL UNIQUE);`)
  for (const sql of TANGLE_IDENTITY_ACCOUNT_INDEXES_SQL) sqlite.exec(sql)
  const db = d1(sqlite)
  return {
    sqlite,
    db,
    store: (options: Omit<D1TangleIdentityStoreOptions, 'db'> = {}) => createD1TangleIdentityStore({ db, ...options }),
    legacyStore: (options: Omit<D1TangleIdentityStoreOptions, 'db' | 'legacyLinkTable'> = {}) => createD1TangleIdentityStore({
      db, ...options,
      legacyLinkTable: { table: 'tangle_identity', userIdColumn: 'user_id', platformUserIdColumn: 'platform_user_id' },
    }),
    user(id: string, email: string, verified = true) {
      sqlite.prepare('INSERT INTO user (id, name, email, emailVerified) VALUES (?, ?, ?, ?)').run(id, id, email, verified ? 1 : 0)
    },
    session(userId: string, token: string, expiresAt = Math.floor(Date.now() / 1000) + 3600) {
      sqlite.prepare('INSERT INTO session (id, userId, token, expiresAt) VALUES (?, ?, ?, ?)').run(`s-${token}`, userId, token, expiresAt)
    },
    link(userId: string, platformUserId: string) {
      sqlite.prepare("INSERT INTO account (id, userId, accountId, providerId) VALUES (?, ?, ?, 'tangle')").run(`a-${userId}`, userId, platformUserId)
    },
    legacyLink(userId: string, platformUserId: string) {
      sqlite.prepare('INSERT INTO tangle_identity (user_id, platform_user_id) VALUES (?, ?)').run(userId, platformUserId)
    },
    links: () => sqlite.prepare("SELECT userId, accountId FROM account WHERE providerId = 'tangle' ORDER BY userId").all(),
    legacyLinks: () => sqlite.prepare('SELECT user_id AS userId, platform_user_id AS accountId FROM tangle_identity ORDER BY user_id').all(),
    users: () => sqlite.prepare('SELECT id, email, emailVerified FROM user ORDER BY id').all(),
    sessions: () => sqlite.prepare('SELECT token FROM session ORDER BY token').all().map(row => (row as { token: string }).token),
  }
}

/** Drive the real identity callback with a controlled platform exchange. */
async function signIn(store: TangleIdentitySsoAccountStore, user: { id: string; email: string; name?: string | null }) {
  const origin = 'http://127.0.0.1:8790'
  const callbackUrl = `${origin}/auth/tangle/callback`
  const auth: TangleIdentitySsoAuthClient = {
    authorizeUrl: ({ state }) => `http://127.0.0.1:4100/cross-site/authorize?state=${encodeURIComponent(state)}`,
    exchange: async () => ({ kind: 'identity', emailVerified: true, user: { name: null, ...user } }),
  }
  const handlers = createTangleSsoHandlers({
    protocol: 'identity', auth, store,
    stateSecret: 'identity-store-test-state-secret-32-bytes',
    callbackUrl, stateCookieName: 'identity_state', secureCookies: false,
    setSessionCookie: async ({ token }) => [`local_session=${token}; Path=/; HttpOnly`],
    log: () => {},
  })
  const started = await handlers.start(new Request(`${origin}/auth/tangle/start?redirect=/app`))
  const stateCookie = started.headers.getSetCookie().find(value => value.startsWith('identity_state='))!.split(';')[0]!
  const state = new URL(started.headers.get('Location')!).searchParams.get('state')!
  const response = await handlers.callback(new Request(`${callbackUrl}?code=c&state=${encodeURIComponent(state)}`, {
    headers: { cookie: stateCookie },
  }))
  const session = response.headers.getSetCookie().find(value => value.startsWith('local_session='))
  return {
    location: response.headers.get('Location'),
    token: session ? session.split(';')[0]!.slice('local_session='.length) : null,
  }
}

function sessionUser(sqlite: DatabaseSync, token: string | null) {
  return (sqlite.prepare('SELECT userId FROM session WHERE token = ?').get(token) as { userId: string } | undefined)?.userId
}

describe('createD1TangleIdentityStore', () => {
  it('creates a verified user, its account link and a session for a new platform user', async () => {
    const h = database()
    const result = await signIn(h.store(), { id: 'p-new', email: ' New@Example.test ' })
    expect(result.location).toBe('/app')
    expect(h.users()).toEqual([expect.objectContaining({ email: 'new@example.test', emailVerified: 1 })])
    const userId = (h.users()[0] as { id: string }).id
    expect(h.links()).toEqual([{ userId, accountId: 'p-new' }])
    expect(sessionUser(h.sqlite, result.token)).toBe(userId)
  })

  it('signs a linked user in by platform id after the platform email changed', async () => {
    const h = database()
    h.user('owner', 'owner@example.test')
    h.link('owner', 'p-owner')
    const result = await signIn(h.store(), { id: 'p-owner', email: 'renamed@example.test' })
    expect(sessionUser(h.sqlite, result.token)).toBe('owner')
    expect(h.users()).toHaveLength(1)
  })

  it('still signs in a user whose only link is the legacy table, and copies it to account', async () => {
    const h = database()
    h.user('owner', 'owner@example.test', false)
    h.legacyLink('owner', 'p-owner')
    // Different platform email and an unverified local email: only the legacy link can match.
    const result = await signIn(h.legacyStore(), { id: 'p-owner', email: 'other@example.test' })
    expect(result.location).toBe('/app')
    expect(sessionUser(h.sqlite, result.token)).toBe('owner')
    expect(h.users()).toHaveLength(1)
    expect(h.links()).toEqual([{ userId: 'owner', accountId: 'p-owner' }])
    expect(h.legacyLinks()).toEqual(h.links())
  })

  it('mirrors a new link into the legacy table during migration', async () => {
    const h = database()
    h.user('member', 'member@example.test')
    const result = await signIn(h.legacyStore(), { id: 'p-member', email: 'member@example.test' })
    expect(sessionUser(h.sqlite, result.token)).toBe('member')
    expect(h.links()).toEqual([{ userId: 'member', accountId: 'p-member' }])
    expect(h.legacyLinks()).toEqual(h.links())
  })

  it('links a verified unbound email account and marks nothing for an unverified one', async () => {
    const h = database()
    h.user('verified', 'verified@example.test')
    h.user('unverified', 'unverified@example.test', false)
    expect(await h.store().resolveAccount({ email: 'verified@example.test', platformUserId: 'p1' }))
      .toEqual({ kind: 'existing', userId: 'verified', matchedBy: 'verified-email' })
    expect(await h.store().resolveAccount({ email: 'unverified@example.test', platformUserId: 'p2' }))
      .toEqual({ kind: 'reject', reason: 'unverified-email' })
    const rejected = await signIn(h.store(), { id: 'p2', email: 'unverified@example.test' })
    expect(rejected.token).toBeNull()
    expect(h.links()).toEqual([])
    expect(h.sessions()).toEqual([])
  })

  it('rejects an email whose account is bound to another platform user', async () => {
    const h = database()
    h.user('owner', 'owner@example.test')
    h.link('owner', 'p-owner')
    expect(await h.store().resolveAccount({ email: 'owner@example.test', platformUserId: 'p-intruder' }))
      .toEqual({ kind: 'reject', reason: 'email-platform-id-conflict' })
  })

  it('rejects when the platform id and the email select different users', async () => {
    const h = database()
    h.user('a', 'a@example.test')
    h.user('b', 'b@example.test')
    h.link('a', 'p-a')
    expect(await h.store().resolveAccount({ email: 'b@example.test', platformUserId: 'p-a' }))
      .toEqual({ kind: 'reject', reason: 'platform-id-email-conflict' })
  })

  it('rejects when account and legacy rows name different platform users', async () => {
    const h = database()
    h.user('owner', 'owner@example.test')
    h.link('owner', 'p-new')
    h.legacyLink('owner', 'p-old')
    expect(await h.legacyStore().resolveAccount({ email: 'x@example.test', platformUserId: 'p-old' }))
      .toEqual({ kind: 'reject', reason: 'platform-id-email-conflict' })
  })

  it('does not change an existing user or publish a link in upsertUserByEmail', async () => {
    const h = database()
    h.user('member', 'member@example.test')
    const store = h.store()
    const resolution = await store.resolveAccount({ email: 'member@example.test', platformUserId: 'p-member' })
    if (resolution.kind === 'reject') throw new Error('expected an existing account')
    const before = h.users()
    expect(await store.upsertUserByEmail({ email: 'member@example.test', name: 'X', tangleUserId: 'p-member', resolution }))
      .toEqual({ userId: 'member' })
    expect(h.users()).toEqual(before)
    expect(h.links()).toEqual([])
  })

  it('rejects saveTangleLink without a live session for that user and writes nothing', async () => {
    const h = database()
    h.user('a', 'a@example.test', false)
    h.user('b', 'b@example.test')
    h.session('b', 'b-token')
    h.session('a', 'a-expired', Math.floor(Date.now() / 1000) - 10)
    const store = h.store({ linkingUserId: 'a' })
    for (const sessionToken of ['b-token', 'a-expired']) {
      await expect(store.saveTangleLink({ userId: 'a', sessionToken, tangleUserId: 'p-a', email: 'a@example.test', name: null }))
        .rejects.toBeInstanceOf(TangleSsoAccountConflictError)
    }
    expect(h.links()).toEqual([])
    expect(h.users()).toContainEqual({ id: 'a', email: 'a@example.test', emailVerified: 0 })
  })

  it('rejects the loser of a platform-id race and deleteSession removes only its session', async () => {
    const h = database()
    h.user('a', 'a@example.test')
    h.user('b', 'b@example.test')
    h.session('a', 'a-other')
    const store = h.store()
    const resolution = await store.resolveAccount({ email: 'a@example.test', platformUserId: 'p-shared' })
    expect(resolution).toEqual({ kind: 'existing', userId: 'a', matchedBy: 'verified-email' })
    const { token } = await store.createSession({ userId: 'a', expiresAt: new Date(Date.now() + 3600_000), ipAddress: null, userAgent: null })
    h.link('b', 'p-shared') // a concurrent callback for user b wins the platform id
    await expect(store.saveTangleLink({ userId: 'a', sessionToken: token, tangleUserId: 'p-shared', email: 'a@example.test', name: null }))
      .rejects.toBeInstanceOf(TangleSsoAccountConflictError)
    await store.deleteSession({ sessionToken: token })
    expect(h.sessions()).toEqual(['a-other'])
    expect(h.links()).toEqual([{ userId: 'b', accountId: 'p-shared' }])
  })

  it('commits nothing when the platform id is taken between resolution and the write', async () => {
    const h = database()
    h.user('a', 'a@example.test')
    h.user('b', 'b@example.test')
    const racing: TangleIdentityD1Like = {
      prepare: query => h.db.prepare(query),
      batch: async statements => {
        h.link('b', 'p-shared') // the competing callback commits first
        return h.db.batch(statements)
      },
    }
    const store = createD1TangleIdentityStore({ db: racing })
    const { token } = await store.createSession({ userId: 'a', expiresAt: new Date(Date.now() + 3600_000), ipAddress: null, userAgent: null })
    await expect(store.saveTangleLink({ userId: 'a', sessionToken: token, tangleUserId: 'p-shared', email: 'a@example.test', name: null }))
      .rejects.toBeInstanceOf(TangleSsoAccountConflictError)
    expect(h.links()).toEqual([{ userId: 'b', accountId: 'p-shared' }])
  })

  it('enforces one tangle account per user and per platform user in the schema', () => {
    const h = database()
    h.user('a', 'a@example.test')
    h.user('b', 'b@example.test')
    h.link('a', 'p-a')
    expect(() => h.sqlite.prepare("INSERT INTO account (id, userId, accountId, providerId) VALUES ('x', 'b', 'p-a', 'tangle')").run()).toThrow(/UNIQUE/)
    expect(() => h.sqlite.prepare("INSERT INTO account (id, userId, accountId, providerId) VALUES ('y', 'a', 'p-b', 'tangle')").run()).toThrow(/UNIQUE/)
    h.sqlite.prepare("INSERT INTO account (id, userId, accountId, providerId) VALUES ('z', 'a', 'a', 'credential')").run()
  })

  it('links the signed-in user in an explicit connect flow, including an unverified local email', async () => {
    const h = database()
    h.user('staff', 'staff@hotel.test', false)
    const result = await signIn(h.store({ linkingUserId: 'staff' }), { id: 'p-staff', email: 'personal@example.test' })
    expect(sessionUser(h.sqlite, result.token)).toBe('staff')
    expect(h.links()).toEqual([{ userId: 'staff', accountId: 'p-staff' }])
    // The connect flow does not verify a local email the platform did not prove.
    expect(h.users()).toContainEqual({ id: 'staff', email: 'staff@hotel.test', emailVerified: 0 })
  })

  it('refuses an explicit connect when the platform user is linked elsewhere', async () => {
    const h = database()
    h.user('staff', 'staff@hotel.test')
    h.user('other', 'other@hotel.test')
    h.link('other', 'p-staff')
    expect(await h.store({ linkingUserId: 'staff' }).resolveAccount({ email: 'x@example.test', platformUserId: 'p-staff' }))
      .toEqual({ kind: 'reject', reason: 'platform-id-email-conflict' })
  })

  it('rejects an invalid legacy identifier', () => {
    const h = database()
    expect(() => createD1TangleIdentityStore({
      db: h.db, legacyLinkTable: { table: 'tangle_identity; DROP TABLE user', userIdColumn: 'user_id', platformUserIdColumn: 'platform_user_id' },
    })).toThrow(/invalid legacyLinkTable.table/)
  })
})
