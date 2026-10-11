/**
 * Better Auth `account`-table store for first-party Tangle identity sign-in
 * (`protocol: 'identity'`) on D1 / SQLite.
 *
 * The platform link is Better Auth's own external-identity row:
 * `account(providerId = 'tangle', accountId = <platform user id>, userId)`.
 * Run {@link TANGLE_IDENTITY_ACCOUNT_INDEXES_SQL} in a product migration; its
 * two partial unique indexes make the link one-per-user and
 * one-per-platform-user, which the write path relies on.
 *
 * Schema expectations are Better Auth's default SQLite model with camelCase
 * columns: `user(id, name, email, emailVerified, createdAt, updatedAt)`,
 * `session(id, userId, token, expiresAt, ipAddress, userAgent, createdAt,
 * updatedAt)` and `account(id, userId, accountId, providerId, createdAt,
 * updatedAt)`, with unix-second integer timestamps (Drizzle `mode:
 * 'timestamp'`). D1 is structural: Cloudflare `D1Database` satisfies
 * {@link TangleIdentityD1Like}.
 */

import {
  normalizeTangleSsoEmail,
  resolveTangleSsoAccount,
  TangleSsoAccountConflictError,
  TangleSsoUserCreateError,
  type TangleIdentitySsoAccountStore,
  type TangleSsoAccountResolution,
  type TangleSsoLocalAccount,
} from './sso'

/** Better Auth `account.providerId` for the Tangle platform link. */
export const TANGLE_IDENTITY_PROVIDER_ID = 'tangle'

/** Partial unique indexes the store requires on Better Auth's `account` table. */
export const TANGLE_IDENTITY_ACCOUNT_INDEXES_SQL = [
  `CREATE UNIQUE INDEX IF NOT EXISTS account_tangle_platform_user ON account(accountId) WHERE providerId = '${TANGLE_IDENTITY_PROVIDER_ID}'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS account_tangle_user ON account(userId) WHERE providerId = '${TANGLE_IDENTITY_PROVIDER_ID}'`,
] as const

/** A prepared D1 statement; Cloudflare `D1PreparedStatement` satisfies it. */
export interface TangleIdentityD1Statement {
  bind(...values: unknown[]): TangleIdentityD1Statement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<unknown>
}

/** The D1 surface the store needs. `batch` must be atomic, as D1's is. */
export interface TangleIdentityD1Like {
  prepare(query: string): TangleIdentityD1Statement
  batch(statements: TangleIdentityD1Statement[]): Promise<Array<{ meta?: { changes?: number } }>>
}

/**
 * A link table the product used before this store. During migration the store
 * reads it after `account` and mirrors new links into it, so a link that
 * exists in either place still signs in and a rollback still finds new links.
 * Remove the option once a reconcile query proves every legacy row has an
 * equal `account` row.
 */
export interface TangleIdentityLegacyLinkTable {
  table: string
  /** Column holding the local `user.id`; must be unique. */
  userIdColumn: string
  /** Column holding the platform user id; must be unique. */
  platformUserIdColumn: string
}

export interface D1TangleIdentityStoreOptions {
  db: TangleIdentityD1Like
  /**
   * The signed-in local user for an explicit "connect Tangle" flow. A live
   * local session plus a verified platform exchange jointly authorize linking
   * that user, even when its local email is unverified or differs. The host
   * must prove the session started this flow (for example with a signed,
   * session-bound cookie).
   */
  linkingUserId?: string
  legacyLinkTable?: TangleIdentityLegacyLinkTable
}

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function identifier(value: string, field: string): string {
  if (!SQL_IDENTIFIER.test(value)) throw new Error(`createD1TangleIdentityStore: invalid ${field}`)
  return value
}

interface CandidateRow {
  userId: string
  email: string
  emailVerified: number | boolean | null
  accountPlatformUserId: string | null
  legacyPlatformUserId: string | null
}

interface Candidate extends TangleSsoLocalAccount {
  /** The account row and the legacy row name different platform users. */
  divergent: boolean
}

function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Create the identity-protocol account store for one request. */
export function createD1TangleIdentityStore(options: D1TangleIdentityStoreOptions): TangleIdentitySsoAccountStore {
  const { db, linkingUserId } = options
  const provider = TANGLE_IDENTITY_PROVIDER_ID
  const legacy = options.legacyLinkTable && {
    table: identifier(options.legacyLinkTable.table, 'legacyLinkTable.table'),
    userId: identifier(options.legacyLinkTable.userIdColumn, 'legacyLinkTable.userIdColumn'),
    platformUserId: identifier(options.legacyLinkTable.platformUserIdColumn, 'legacyLinkTable.platformUserIdColumn'),
  }

  const selectAccount = `SELECT u.id AS userId, u.email AS email, u.emailVerified AS emailVerified,
      a.accountId AS accountPlatformUserId,
      ${legacy ? `l.${legacy.platformUserId}` : 'NULL'} AS legacyPlatformUserId
    FROM user u
    LEFT JOIN account a ON a.userId = u.id AND a.providerId = '${provider}'
    ${legacy ? `LEFT JOIN ${legacy.table} l ON l.${legacy.userId} = u.id` : ''}`

  function toCandidate(row: CandidateRow): Candidate {
    const fromAccount = row.accountPlatformUserId?.trim() || null
    const fromLegacy = row.legacyPlatformUserId?.trim() || null
    return {
      userId: row.userId,
      email: row.email,
      emailVerified: row.emailVerified === 1 || row.emailVerified === true,
      platformUserId: fromAccount ?? fromLegacy,
      divergent: Boolean(fromAccount && fromLegacy && fromAccount !== fromLegacy),
    }
  }

  async function candidates(email: string, platformUserId: string) {
    const where = legacy
      ? `WHERE lower(trim(u.email)) = ? OR a.accountId = ? OR l.${legacy.platformUserId} = ?`
      : 'WHERE lower(trim(u.email)) = ? OR a.accountId = ?'
    const values = legacy ? [email, platformUserId, platformUserId] : [email, platformUserId]
    const { results } = await db.prepare(`${selectAccount} ${where}`).bind(...values).all<CandidateRow>()
    const rows = results.map(toCandidate)
    return {
      divergent: rows.some(row => row.divergent),
      platformMatches: rows.filter(row => row.platformUserId === platformUserId),
      emailMatches: rows.filter(row => normalizeTangleSsoEmail(row.email) === email),
    }
  }

  const store: TangleIdentitySsoAccountStore = {
    async resolveAccount({ email, platformUserId }): Promise<TangleSsoAccountResolution> {
      const normalizedEmail = normalizeTangleSsoEmail(email)
      const stableId = platformUserId.trim()
      const found = await candidates(normalizedEmail, stableId)
      if (found.divergent) return { kind: 'reject', reason: 'platform-id-email-conflict' }
      if (!linkingUserId) {
        return resolveTangleSsoAccount({
          email: normalizedEmail,
          platformUserId: stableId,
          platformMatches: found.platformMatches,
          emailMatches: found.emailMatches,
        })
      }

      const ownRow = await db.prepare(`${selectAccount} WHERE u.id = ?`).bind(linkingUserId).first<CandidateRow>()
      if (!ownRow) return { kind: 'reject', reason: 'email-match-mismatch' }
      const own = toCandidate(ownRow)
      if (own.divergent) return { kind: 'reject', reason: 'platform-id-email-conflict' }
      if (own.platformUserId && own.platformUserId !== stableId) {
        return { kind: 'reject', reason: 'email-platform-id-conflict' }
      }
      if (found.platformMatches.some(row => row.userId !== linkingUserId)
        || found.emailMatches.some(row => row.userId !== linkingUserId)) {
        return { kind: 'reject', reason: 'platform-id-email-conflict' }
      }
      return { kind: 'existing', userId: linkingUserId, matchedBy: 'platform-id' }
    },

    async upsertUserByEmail({ email, name, tangleUserId, resolution }) {
      const normalizedEmail = normalizeTangleSsoEmail(email)
      const platformUserId = tangleUserId.trim()
      const current = await store.resolveAccount({ email: normalizedEmail, platformUserId })
      if (current.kind === 'reject') throw new TangleSsoAccountConflictError(current.reason)
      if (current.kind === 'existing') {
        if (resolution.kind === 'existing' && resolution.userId !== current.userId) {
          throw new TangleSsoAccountConflictError('platform-id-email-conflict')
        }
        return { userId: current.userId }
      }

      if (resolution.kind !== 'create') throw new TangleSsoUserCreateError('The selected account changed')
      const userId = crypto.randomUUID()
      try {
        await db.prepare(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
          VALUES (?, ?, ?, 1, unixepoch(), unixepoch())`)
          .bind(userId, name || normalizedEmail, normalizedEmail).run()
      } catch {
        // A concurrent callback may have won the email UNIQUE race. Re-apply the
        // policy; never adopt that row by email alone.
        const after = await store.resolveAccount({ email: normalizedEmail, platformUserId })
        if (after.kind === 'reject') throw new TangleSsoAccountConflictError(after.reason)
        if (after.kind === 'existing') return { userId: after.userId }
        throw new TangleSsoUserCreateError()
      }
      return { userId }
    },

    async createSession({ userId, expiresAt, ipAddress, userAgent }) {
      const token = randomToken()
      await db.prepare(`INSERT INTO session (id, userId, token, expiresAt, ipAddress, userAgent, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`)
        .bind(crypto.randomUUID(), userId, token, Math.floor(expiresAt.getTime() / 1000), ipAddress, userAgent)
        .run()
      return { token }
    },

    async saveTangleLink({ userId, sessionToken, tangleUserId, email }) {
      const platformUserId = tangleUserId.trim()
      const normalizedEmail = normalizeTangleSsoEmail(email)
      const session = await db.prepare('SELECT userId FROM session WHERE token = ? AND expiresAt > unixepoch()')
        .bind(sessionToken).first<{ userId: string }>()
      if (session?.userId !== userId) throw new TangleSsoAccountConflictError('email-platform-id-conflict')
      const current = await store.resolveAccount({ email: normalizedEmail, platformUserId })
      if (current.kind === 'reject') throw new TangleSsoAccountConflictError(current.reason)
      if (current.kind !== 'existing' || current.userId !== userId) {
        throw new TangleSsoAccountConflictError('platform-id-email-conflict')
      }

      // One atomic batch: every statement re-checks the live session and the
      // email owner, and the final verified-email update runs only when this
      // exact link exists, so a lost race commits nothing and rejects.
      const liveSession = 'EXISTS (SELECT 1 FROM session WHERE token = ? AND userId = ? AND expiresAt > unixepoch())'
      const emailFree = 'NOT EXISTS (SELECT 1 FROM user WHERE lower(trim(email)) = ? AND id <> ?)'
      const linked = `EXISTS (SELECT 1 FROM account WHERE providerId = '${provider}' AND userId = ? AND accountId = ?)`
      const statements = [
        db.prepare(`INSERT INTO account (id, userId, accountId, providerId, createdAt, updatedAt)
            SELECT ?, ?, ?, '${provider}', unixepoch(), unixepoch()
            WHERE EXISTS (SELECT 1 FROM user WHERE id = ?) AND ${liveSession} AND ${emailFree}
            ON CONFLICT DO NOTHING`)
          .bind(crypto.randomUUID(), userId, platformUserId, userId, sessionToken, userId, normalizedEmail, userId),
      ]
      if (legacy) {
        statements.push(db.prepare(`INSERT INTO ${legacy.table} (${legacy.userId}, ${legacy.platformUserId})
            SELECT ?, ? WHERE ${linked}
            ON CONFLICT DO NOTHING`)
          .bind(userId, platformUserId, userId, platformUserId))
      }
      statements.push(db.prepare(`UPDATE user SET emailVerified = CASE WHEN lower(trim(email)) = ? THEN 1 ELSE emailVerified END,
            updatedAt = unixepoch()
          WHERE id = ? AND ${liveSession} AND ${linked} AND ${emailFree}`)
        .bind(normalizedEmail, userId, sessionToken, userId, userId, platformUserId, normalizedEmail, userId))
      const results = await db.batch(statements)
      if (results[results.length - 1]?.meta?.changes !== 1) {
        throw new TangleSsoAccountConflictError('email-platform-id-conflict')
      }
    },

    // `saveTangleLink` is one atomic batch, so a rejected call wrote nothing;
    // removing the unpublished session is the whole cleanup.
    async deleteSession({ sessionToken }) {
      await db.prepare('DELETE FROM session WHERE token = ?').bind(sessionToken).run()
    },
  }
  return store
}
