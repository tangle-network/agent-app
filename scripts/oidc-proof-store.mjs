import { DatabaseSync } from 'node:sqlite'
import { mkdir, open, readFile, chmod } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createFieldCrypto } from '@tangle-network/agent-app/crypto'
import { normalizeTangleSsoEmail, resolveTangleSsoAccount } from '@tangle-network/agent-app/platform'

const sha = (value) => createHash('sha256').update(value).digest('hex')

/** Durable local proof storage. Each registered client owns one database and key file. */
export async function openOidcProofStore({ path, binding }) {
  process.umask(0o077)
  const dbPath = resolve(path)
  await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 })
  const keyPath = dbPath + '.key'
  try {
    const file = await open(keyPath, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify({
        encryptionKey: randomBytes(32).toString('hex'),
        stateSecret: randomBytes(32).toString('hex'),
      }) + '\n')
      await file.sync()
    } finally { await file.close() }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const secrets = JSON.parse(await readFile(keyPath, 'utf8'))
  if (![secrets.encryptionKey, secrets.stateSecret].every((key) => typeof key === 'string' && /^[0-9a-f]{64}$/.test(key))) {
    throw new Error('Invalid persisted OIDC proof keys')
  }
  await chmod(keyPath, 0o600)
  const fields = createFieldCrypto(secrets.encryptionKey)
  const db = new DatabaseSync(dbPath)
  await chmod(dbPath, 0o600)
  db.exec([
    'PRAGMA journal_mode=WAL',
    'PRAGMA synchronous=FULL',
    'PRAGMA foreign_keys=ON',
    'CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, platform_id TEXT NOT NULL UNIQUE, email_hash TEXT NOT NULL, payload TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS users_email ON users(email_hash)',
    'CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, access_expires_at INTEGER, credentials TEXT, blocked INTEGER NOT NULL DEFAULT 1)',
  ].join(';'))
  const serializedBinding = JSON.stringify(binding)
  db.prepare('INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)').run('binding', serializedBinding)
  if (db.prepare('SELECT value FROM metadata WHERE key = ?').get('binding').value !== serializedBinding) {
    db.close()
    throw new Error('OIDC proof database belongs to a different issuer, client, or callback')
  }
  const decodeUser = async (row) => row ? {
    ...JSON.parse(await fields.decrypt(row.payload)),
    id: row.id,
    platformUserId: row.platform_id,
  } : undefined
  const readUser = (id) => decodeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id))
  const requireChange = (result) => {
    if (result.changes !== 1) throw new Error('OIDC proof session disappeared during persistence')
  }
  return {
    stateSecret: secrets.stateSecret,
    close: () => db.close(),
    async resolveAccount({ email, platformUserId }) {
      const platformMatches = await Promise.all(db.prepare('SELECT * FROM users WHERE platform_id = ?').all(platformUserId).map(decodeUser))
      const emailMatches = await Promise.all(db.prepare('SELECT * FROM users WHERE email_hash = ?').all(sha(normalizeTangleSsoEmail(email))).map(decodeUser))
      const account = (user) => ({ userId: user.id, email: user.email, emailVerified: true, platformUserId: user.platformUserId })
      return resolveTangleSsoAccount({ email, platformUserId, platformMatches: platformMatches.map(account), emailMatches: emailMatches.map(account) })
    },
    async upsertUserByEmail({ tangleUserId, email, name, resolution }) {
      const userId = resolution.kind === 'existing' ? resolution.userId : tangleUserId
      const payload = await fields.encrypt(JSON.stringify({ email, name }))
      db.prepare('INSERT INTO users(id, platform_id, email_hash, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET platform_id=excluded.platform_id, email_hash=excluded.email_hash, payload=excluded.payload').run(userId, tangleUserId, sha(normalizeTangleSsoEmail(email)), payload)
      return { userId }
    },
    async createSession({ userId, expiresAt }) {
      const token = randomBytes(32).toString('hex')
      db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), userId, +expiresAt)
      return { token }
    },
    async saveTangleLink({ sessionToken, tokens, accessTokenExpiresAt }) {
      const credentials = await fields.encrypt(JSON.stringify(tokens))
      requireChange(db.prepare('UPDATE sessions SET credentials = ?, access_expires_at = ?, blocked = 0 WHERE token_hash = ?').run(credentials, +accessTokenExpiresAt, sha(sessionToken)))
    },
    async deleteSession({ sessionToken }) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(sessionToken))
    },
    async readSession(token) {
      if (!token || !/^[0-9a-f]{64}$/.test(token)) return undefined
      const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha(token))
      if (!row || !row.credentials) return undefined
      return {
        userId: row.user_id,
        user: await readUser(row.user_id),
        expiresAt: row.expires_at,
        accessTokenExpiresAt: row.access_expires_at,
        tokens: JSON.parse(await fields.decrypt(row.credentials)),
        blocked: Boolean(row.blocked),
      }
    },
    blockSession(token) {
      requireChange(db.prepare('UPDATE sessions SET blocked = 1 WHERE token_hash = ?').run(sha(token)))
    },
    async saveRefreshedTokens(token, tokens) {
      const credentials = await fields.encrypt(JSON.stringify(tokens))
      requireChange(db.prepare('UPDATE sessions SET credentials = ?, blocked = 1 WHERE token_hash = ?').run(credentials, sha(token)))
    },
    finishRefresh(token, accessTokenExpiresAt) {
      requireChange(db.prepare('UPDATE sessions SET access_expires_at = ?, blocked = 0 WHERE token_hash = ?').run(accessTokenExpiresAt, sha(token)))
    },
  }
}
