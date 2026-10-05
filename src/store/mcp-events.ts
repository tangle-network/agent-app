/** Durable host glue for the MCP Events kit. No task engine or protocol lives here.
 * D1 is the application's existing database; its existing scheduled handler calls
 * run(). Encryption uses the host's maintained vault, not a second key store. */
export interface EventCipher {
  encrypt(plaintext: string): Promise<string>
  decrypt(ciphertext: string): Promise<string>
}
export interface DurableEventData {
  owner: { app: string; user: string; nativeUser: string }
  active: boolean
  nextAt: number
}
export interface D1EventStatement {
  bind(...values: unknown[]): D1EventStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<{ meta: { changes: number } }>
}
export interface D1EventDatabase {
  prepare(sql: string): D1EventStatement
  /** D1 batch is transactional. A sequential fallback is NOT safe here. */
  batch(statements: D1EventStatement[]): Promise<Array<{ meta: { changes: number } }>>
}
export interface DurableEventRow<T> { id: string; revision: number; data: T }
interface StoredRow { id: string; revision: number; owner: string; active: number; next_at: number; payload: string }

/** Apply through each host's ordinary D1 migration runner, never on requests. */
export const MCP_EVENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_app_mcp_events (
  app TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
  owner TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
  next_at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(app,id)
);
CREATE INDEX IF NOT EXISTS agent_app_mcp_events_due ON agent_app_mcp_events(app,active,next_at);
CREATE INDEX IF NOT EXISTS agent_app_mcp_events_owner ON agent_app_mcp_events(app,owner,active);
CREATE TABLE IF NOT EXISTS agent_app_mcp_event_worker (
  app TEXT PRIMARY KEY, due_at INTEGER, lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT, heartbeat_at INTEGER NOT NULL DEFAULT 0
);`

const encoder = new TextEncoder()
async function ownerKey(data: DurableEventData) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([
    data.owner.app, data.owner.user, data.owner.nativeUser,
  ])))
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
}

export function createD1McpEventHost<T extends DurableEventData>(options: {
  db: D1EventDatabase; app: string; cipher: EventCipher; now?: () => number
}) {
  const { db, app, cipher } = options
  const now = options.now ?? Date.now
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(app)) throw new Error('invalid_event_app')
  const statement = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values)
  async function unpack(row: StoredRow): Promise<DurableEventRow<T>> {
    const value = JSON.parse(await cipher.decrypt(row.payload)) as { version: number; app: string; id: string; data: T }
    // Authenticated plaintext binds ciphertext to the row/app. Swapping encrypted
    // records, including across tenants, must not retarget signing credentials.
    if (value.version !== 1 || value.app !== app || value.id !== row.id
      || value.data.owner.app !== app || await ownerKey(value.data) !== row.owner
      || Number(value.data.active) !== row.active || value.data.nextAt !== row.next_at) {
      throw new Error('event_record_binding_mismatch')
    }
    return { id: row.id, revision: row.revision, data: value.data }
  }
  const store = {
    async get(id: string): Promise<DurableEventRow<T> | null> {
      const row = await statement('SELECT * FROM agent_app_mcp_events WHERE app=? AND id=?', app, id).first<StoredRow>()
      return row ? unpack(row) : null
    },
    async put(id: string, expected: number | null, data: T): Promise<boolean> {
      if (data.owner.app !== app || !Number.isSafeInteger(data.nextAt)
        || !id || id.length > 256 || (expected !== null && (!Number.isSafeInteger(expected) || expected < 1))) {
        throw new Error('invalid_event_record')
      }
      const owner = await ownerKey(data)
      const plaintext = JSON.stringify({ version: 1, app, id, data })
      if (encoder.encode(plaintext).byteLength > 524288) throw new Error('event_record_too_large')
      const payload = await cipher.encrypt(plaintext)
      const active = Number(data.active)
      const prune = statement('DELETE FROM agent_app_mcp_events WHERE app=? AND owner=? AND active=0 AND next_at<?', app, owner, now() - 86400000)
      // Admission and CAS are one SQL statement, in the same transaction as
      // pruning. Concurrent isolates cannot both spend the last quota slot.
      const write = expected === null
        ? statement(`INSERT OR IGNORE INTO agent_app_mcp_events(app,id,revision,owner,active,next_at,payload)
          SELECT ?,?,1,?,?,?,? WHERE
          (SELECT count(*) FROM agent_app_mcp_events WHERE app=? AND owner=?) < 256 AND
          (?=0 OR (SELECT count(*) FROM agent_app_mcp_events WHERE app=? AND owner=? AND active=1) < 64)`,
          app, id, owner, active, data.nextAt, payload, app, owner, active, app, owner)
        : statement(`UPDATE agent_app_mcp_events SET revision=revision+1,active=?,next_at=?,payload=?
          WHERE app=? AND id=? AND revision=? AND owner=? AND
          (?=0 OR (SELECT count(*) FROM agent_app_mcp_events WHERE app=? AND owner=? AND active=1 AND id<>?) < 64)`,
          active, data.nextAt, payload, app, id, expected, owner, active, app, owner, id)
      return (await db.batch([prune, write]))[1]?.meta.changes === 1
    },
    async due(time: number, limit: number): Promise<Array<DurableEventRow<T>>> {
      if (!Number.isSafeInteger(time) || !Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error('invalid_event_batch')
      const rows = await statement('SELECT * FROM agent_app_mcp_events WHERE app=? AND active=1 AND next_at<=? ORDER BY next_at,id LIMIT ?', app, time, limit).all<StoredRow>()
      return Promise.all(rows.results.map(unpack))
    },
    async nextDue(): Promise<number | null> {
      const row = await statement('SELECT min(next_at) AS at FROM agent_app_mcp_events WHERE app=? AND active=1', app).first<{ at: number | null }>()
      return row?.at ?? null
    },
  }
  async function wake(at: number): Promise<void> {
    if (!Number.isSafeInteger(at)) throw new Error('invalid_event_wake')
    await statement(`INSERT INTO agent_app_mcp_event_worker(app,due_at) VALUES(?,?)
      ON CONFLICT(app) DO UPDATE SET due_at=min(coalesce(due_at,excluded.due_at),excluded.due_at)`, app, at).run()
  }
  /** A recent real scheduled invocation is required before discovery advertises
   * delivery. This is not a process-local ready flag or a queue acknowledgement. */
  async function ready(): Promise<boolean> {
    const row = await statement('SELECT heartbeat_at FROM agent_app_mcp_event_worker WHERE app=?', app).first<{ heartbeat_at: number }>()
    return !!row && row.heartbeat_at > 0 && row.heartbeat_at >= now() - 150000
  }
  /** Called only by the existing cron/queue handler. A persisted wake plus the
   * subscription due index close both sides of the store.put()/wake() crash gap.
   * A stale lease recovers automatically; a concurrent wake is never deleted. */
  async function run<R>(drain: () => Promise<R>): Promise<R | null> {
    const time = now(), lease = crypto.randomUUID()
    await statement(`INSERT INTO agent_app_mcp_event_worker(app,heartbeat_at) VALUES(?,?)
      ON CONFLICT(app) DO UPDATE SET heartbeat_at=excluded.heartbeat_at`, app, time).run()
    const claimed = await statement(`UPDATE agent_app_mcp_event_worker SET due_at=NULL,lease_until=?,lease_token=?
      WHERE app=? AND lease_until<=? AND (due_at<=? OR EXISTS (
        SELECT 1 FROM agent_app_mcp_events WHERE app=? AND active=1 AND next_at<=?))`,
      time + 300000, lease, app, time, time, app, time).run()
    if (claimed.meta.changes !== 1) return null
    try { return await drain() }
    finally {
      // Do not clear due_at: drain() or a concurrent subscribe may have queued it.
      await statement('UPDATE agent_app_mcp_event_worker SET lease_until=0,lease_token=NULL WHERE app=? AND lease_token=?', app, lease).run()
    }
  }
  return { store, wake, ready, run }
}

async function boundedText(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > max) throw new Error('event_relay_response_too_large')
      chunks.push(part.value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/** Workers cannot pin HTTPS DNS via fetch. Platform owns the maintained pinned
 * public-HTTPS transport. It forwards already-signed bytes, never signing keys,
 * native task credentials, or an end user's access token. */
export function createMcpEventRelay(options: {
  url: string; serviceName: string; serviceToken: string; fetch?: typeof fetch
}) {
  const url = new URL(options.url)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !options.serviceToken || !/^[a-z][a-z0-9-]{1,64}$/.test(options.serviceName)) throw new Error('invalid_event_relay')
  const send = options.fetch ?? globalThis.fetch
  const auth = { authorization: `Bearer ${options.serviceToken}`, 'x-service-name': options.serviceName }
  async function ready(): Promise<boolean> {
    const response = await send(url, { method: 'GET', headers: auth, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) })
    if (!response.ok) { await response.body?.cancel(); return false }
    const value = JSON.parse(await boundedText(response, 8192)) as { version?: unknown; transport?: unknown; configured?: unknown }
    return value.version === 1 && value.transport === 'pinned-public-https' && value.configured === true
  }
  async function post(callback: string, body: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ status: number; body: string }> {
    const response = await send(url, { method: 'POST', redirect: 'error', cache: 'no-store', signal,
      headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ url: callback, body, headers }) })
    if (!response.ok) { await response.body?.cancel(); throw new Error('event_relay_unavailable') }
    const value = JSON.parse(await boundedText(response, 65536)) as { status?: unknown; body?: unknown }
    if (!Number.isInteger(value.status) || (value.status as number) < 100 || (value.status as number) > 599
      || typeof value.body !== 'string' || encoder.encode(value.body).length > 8192) throw new Error('invalid_event_relay_response')
    return { status: value.status as number, body: value.body }
  }
  return { ready, post }
}
