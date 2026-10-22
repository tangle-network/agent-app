/** Retained application SQL contracts → real SQLite → BetterAuth HTTP → persisted session. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { index, text } from 'drizzle-orm/sqlite-core'
import { expect, it } from 'vitest'
import { createAppAuth, type AppAuth } from '../src/app-auth'
import { createAppAuthTables } from '../src/app-auth/drizzle'
import { createBetterAuthSessionCookieMinter } from '../src/platform/sso'
import { openDatabase } from './teams/db-helper'

// Column/index/FK contracts retained from Legal 522e1c33 and Hospitality 031c6612.
// No issuer column or issuer/account index exists in either application declaration.
function legacySql(legal: boolean): string {
  const created = 'createdAt INTEGER NOT NULL DEFAULT (unixepoch())'
  const updated = 'updatedAt INTEGER NOT NULL DEFAULT (unixepoch())'
  return `
    CREATE TABLE user (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT,
      ${legal ? 'platform_user_id TEXT,' : ''} ${created}, ${updated}
    );
    ${legal ? 'CREATE INDEX idx_user_platform_user_id ON user(platform_user_id);' : ''}
    CREATE TABLE session (
      id TEXT PRIMARY KEY NOT NULL, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE, expiresAt INTEGER NOT NULL, ipAddress TEXT, userAgent TEXT,
      ${legal ? 'tangleApiKey TEXT,' : ''} ${created}, ${updated}
    );
    CREATE TABLE account (
      id TEXT PRIMARY KEY NOT NULL, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      accountId TEXT NOT NULL, providerId TEXT NOT NULL, accessToken TEXT, refreshToken TEXT,
      accessTokenExpiresAt INTEGER, refreshTokenExpiresAt INTEGER, scope TEXT, idToken TEXT, password TEXT,
      ${created}, ${updated}
    );
    CREATE TABLE verification (
      id TEXT PRIMARY KEY NOT NULL, identifier TEXT NOT NULL, value TEXT NOT NULL,
      expiresAt INTEGER NOT NULL, ${created}, ${updated}
    );
  `
}

function schemaSnapshot(sqlite: Database.Database) {
  return Object.fromEntries(['user', 'session', 'account', 'verification'].map(table => [table, {
    columns: sqlite.prepare(`PRAGMA table_info("${table}")`).all(),
    foreignKeys: sqlite.prepare(`PRAGMA foreign_key_list("${table}")`).all(),
    indexes: (sqlite.prepare(`PRAGMA index_list("${table}")`).all() as { name: string; unique: number; origin: string; partial: number }[])
      .map(({ name, unique, origin, partial }) => ({ name, unique, origin, partial,
        columns: sqlite.prepare(`PRAGMA index_info("${name}")`).all() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }]))
}

async function serveAuth(configure: (origin: string) => AppAuth) {
  let auth: AppAuth | undefined
  let origin = ''
  const server = createServer(async (incoming, outgoing) => {
      try {
        if (!auth) throw new Error('Auth fixture not initialized')
        const headers = new Headers()
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach(item => headers.append(key, item))
          else if (value !== undefined) headers.set(key, value)
        }
        const chunks: Buffer[] = []
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
        const response = await auth.auth.handler(new Request(origin + incoming.url, {
          method: incoming.method, headers,
          ...(chunks.length ? { body: new Uint8Array(Buffer.concat(chunks)).buffer } : {}),
        }))
        outgoing.statusCode = response.status
        response.headers.forEach((value, key) => { if (key !== 'set-cookie') outgoing.setHeader(key, value) })
        const cookies = response.headers.getSetCookie()
        if (cookies.length) outgoing.setHeader('set-cookie', cookies)
        outgoing.end(Buffer.from(await response.arrayBuffer()))
      } catch (error) {
        outgoing.writeHead(500).end(error instanceof Error ? error.message : String(error))
      }
    })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Auth listener has no port')
  origin = `http://127.0.0.1:${address.port}`
  try { auth = configure(origin) }
  catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); throw error }
  return { auth, origin, close: () => new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve())) }
}

for (const legal of [false, true]) {
  it(`preserves ${legal ? 'Legal' : 'Hospitality'} migrated auth tables through SSO session minting, HTTP lookup and revocation`, async () => {
    const tables = legal
      ? createAppAuthTables({ accountIssuer: false,
          userColumns: { platformUserId: text('platform_user_id') },
          userIndexes: table => [index('idx_user_platform_user_id').on(table.platformUserId)],
          sessionColumns: { tangleApiKey: text('tangleApiKey') } })
      : createAppAuthTables({ accountIssuer: false })
    const db = openDatabase([tables.users, tables.sessions, tables.accounts, tables.verifications])
    const baseline = new Database(':memory:')
    let running: Awaited<ReturnType<typeof serveAuth>> | undefined
    try {
      baseline.exec(legacySql(legal))
      expect(schemaSnapshot(db.$client)).toEqual(schemaSnapshot(baseline))
      type NoIssuer<T> = 'issuer' extends keyof T ? never : T
      const retainedAccount: NoIssuer<typeof tables.accounts.$inferInsert> = {
        id: 'retained-account', userId: 'retained-user', accountId: 'retained-provider-id', providerId: 'external',
      }
      await db.insert(tables.users).values({ id: 'retained-user', name: 'Retained fixture', email: 'retained@example.test' })
      await db.insert(tables.accounts).values(retainedAccount)
      expect((await db.select().from(tables.accounts))[0]?.accountId).toBe('retained-provider-id')

      running = await serveAuth(origin => createAppAuth({ appName: 'Schema integration', baseURL: origin,
        secret: randomUUID() + randomUUID(), trustedOrigins: [origin],
        db, schema: tables, sessionCookieCacheSeconds: false,
        ...(legal ? { emailAndPassword: false } : {}) }))
      const { auth, origin } = running
      // Validate their persisted SSO sessions through BetterAuth's own cookie minter.
      // Legal disables passwords. The framework's installed credential adapter needs
      // issuer for signup; Hospitality's separately pinned dependency differs, so
      // its password flow is covered by that app's gate without changing its schema.
      const token = randomUUID()
      await db.insert(tables.sessions).values({ id: randomUUID(), userId: 'retained-user',
        token, expiresAt: new Date(Date.now() + 60_000) })
      const signed = await createBetterAuthSessionCookieMinter(auth.auth)({ token, ttlSeconds: 60, expiresAt: new Date(Date.now() + 60_000), secure: false })
      const cookie = signed.map(value => value.split(';')[0]).join('; ')
      expect(cookie).toContain('session_token=')
      const readSession = () => fetch(origin + '/api/auth/get-session', { headers: { cookie } })
      const sessionResponse = await readSession()
      expect(sessionResponse.status).toBe(200)
      const session = await sessionResponse.json() as { user: { email: string }; session: { token: string } }
      expect(session.user.email).toBe('retained@example.test')
      expect((await db.select().from(tables.sessions).where(eq(tables.sessions.token, session.session.token)))).toHaveLength(1)
      await db.delete(tables.sessions).where(eq(tables.sessions.token, session.session.token))
      expect(await (await readSession()).json()).toBeNull()
      expect(schemaSnapshot(db.$client)).toEqual(schemaSnapshot(baseline))
      expect((await db.select().from(tables.accounts).where(eq(tables.accounts.id, retainedAccount.id)))).toHaveLength(1)
    } finally {
      await running?.close()
      baseline.close()
      db.$client.close()
    }
  }, 20_000)
}

it('keeps issuer and its uniqueness as the default account contract', async () => {
  const tables = createAppAuthTables()
  const db = openDatabase([tables.users, tables.sessions, tables.accounts, tables.verifications])
  let running: Awaited<ReturnType<typeof serveAuth>> | undefined
  try {
    await db.insert(tables.users).values({ id: 'u', name: 'Default fixture', email: 'default@example.test' })
    await db.insert(tables.accounts).values({ id: 'a', userId: 'u', accountId: 'provider-id', providerId: 'credential' })
    expect((await db.select().from(tables.accounts))[0]?.issuer).toBe('local:credential')
    await expect(db.insert(tables.accounts).values({ id: 'b', userId: 'u', accountId: 'provider-id', providerId: 'other' }))
      .rejects.toThrow()
    running = await serveAuth(origin => createAppAuth({ appName: 'Default schema integration', baseURL: origin,
      secret: randomUUID() + randomUUID(), trustedOrigins: [origin], db, schema: tables,
      sessionCookieCacheSeconds: false }))
    const credentials = { name: 'Password fixture', email: 'password@example.test', password: randomUUID() }
    const post = (path: string) => fetch(running!.origin + '/api/auth/' + path, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: running!.origin },
      body: JSON.stringify(credentials),
    })
    const signup = await post('sign-up/email')
    expect(signup.status, await signup.clone().text()).toBe(200)
    const login = await post('sign-in/email')
    expect(login.status, await login.clone().text()).toBe(200)
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const session = await (await fetch(running.origin + '/api/auth/get-session', { headers: { cookie } })).json()
    expect(session.user.email).toBe(credentials.email)
    expect((await db.select().from(tables.accounts)).find(row => row.userId === session.user.id)?.issuer).toBe('local:credential')
  } finally {
    await running?.close()
    db.$client.close()
  }
})
