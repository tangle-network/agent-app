import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'

// Execute the production source with Node's type erasure, not a second adapter.
const emitted = stripTypeScriptTypes(readFileSync(new URL('../src/store/mcp-events.ts', import.meta.url), 'utf8'))
const { createD1McpEventHost, createMcpEventRelay, MCP_EVENT_SCHEMA_SQL } = await import(`data:text/javascript;base64,${Buffer.from(emitted + '\n//# sourceURL=mcp-events.ts').toString('base64')}`)
const key = randomBytes(32)
const cipher = {
  async encrypt(value) {
    const iv = randomBytes(12), enc = createCipheriv('aes-256-gcm', key, iv)
    const data = Buffer.concat([enc.update(value, 'utf8'), enc.final()])
    return Buffer.concat([iv, enc.getAuthTag(), data]).toString('base64')
  },
  async decrypt(value) {
    const data = Buffer.from(value, 'base64'), dec = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
    dec.setAuthTag(data.subarray(12, 28))
    return Buffer.concat([dec.update(data.subarray(28)), dec.final()]).toString('utf8')
  },
}
function d1(sqlite) {
  return {
    prepare(sql) {
      let bindings = []
      return {
        bind(...values) { bindings = values; return this },
        async first() { return sqlite.prepare(sql).get(...bindings) ?? null },
        async all() { return { results: sqlite.prepare(sql).all(...bindings) } },
        async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...bindings).changes) } } },
      }
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE')
      try { const results = []; for (const s of statements) results.push(await s.run()); sqlite.exec('COMMIT'); return results }
      catch (error) { sqlite.exec('ROLLBACK'); throw error }
    },
  }
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-events-')), path = join(dir, 'app.sqlite')
  let sqlite = new DatabaseSync(path), time = 1800000000000
  sqlite.exec(MCP_EVENT_SCHEMA_SQL)
  const host = (app = 'test-app') => createD1McpEventHost({ db: d1(sqlite), app, cipher, now: () => time })
  return {
    host, get db() { return sqlite }, advance(ms) { time += ms }, get time() { return time },
    reopen() { sqlite.close(); sqlite = new DatabaseSync(path); return host() },
    close() { sqlite.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}
const data = (overrides = {}) => ({ owner: { app: 'test-app', user: 'u1', nativeUser: 'n1' }, active: true, nextAt: 1800000000000, secret: 'whsec_test_must_not_be_plaintext', pending: { eventId: 'evt1', body: '{"real":"retained bytes"}', digest: 'd1' }, ...overrides })

test('durable encrypted pending bytes, identity and CAS survive connection restart', async () => {
  const f = fixture()
  try {
    let h = f.host()
    assert.equal(await h.store.put('s1', null, data()), true)
    const raw = f.db.prepare('SELECT payload FROM agent_app_mcp_events').get().payload
    assert.equal(raw.includes('whsec_'), false)
    h = f.reopen()
    const row = await h.store.get('s1')
    assert.equal(row.revision, 1); assert.equal(row.data.pending.eventId, 'evt1')
    assert.equal(await h.store.put('s1', 1, { ...row.data, nextAt: f.time + 10 }), true)
    assert.equal(await h.store.put('s1', 1, row.data), false)
    assert.equal((await h.store.get('s1')).revision, 2)
  } finally { f.close() }
})

test('namespace isolation and authenticated row binding reject record substitution', async () => {
  const f = fixture()
  try {
    const h = f.host()
    await h.store.put('s1', null, data()); await h.store.put('s2', null, data())
    assert.equal(await f.host('another-app').store.get('s1'), null)
    assert.deepEqual(await f.host('another-app').store.due(f.time, 32), [])
    await assert.rejects(() => h.store.put('bad', null, data({ owner: { app: 'another-app', user: 'u1', nativeUser: 'n1' } })))
    f.db.exec("UPDATE agent_app_mcp_events SET payload=(SELECT payload FROM agent_app_mcp_events WHERE id='s1') WHERE id='s2'")
    await assert.rejects(() => h.store.get('s2'), /binding_mismatch/)
  } finally { f.close() }
})

test('atomic active quota and unsubscribe tombstone prevent stale activation', async () => {
  const f = fixture()
  try {
    const h = f.host()
    for (let n = 0; n < 64; n++) assert.equal(await h.store.put(`s${n}`, null, data()), true)
    assert.equal(await h.store.put('over-quota', null, data()), false)
    const row = await h.store.get('s0')
    assert.equal(await h.store.put('s0', row.revision, { ...row.data, active: false, secret: '', pending: undefined }), true)
    assert.equal(await h.store.put('s0', row.revision, row.data), false)
    assert.equal(await h.store.put('replacement', null, data()), true)
    assert.equal((await h.store.due(f.time, 128)).length, 64)
  } finally { f.close() }
})

test('total record quota and one-day tombstone pruning remain bounded', async () => {
  const f = fixture()
  try {
    const h = f.host()
    for (let n = 0; n < 256; n++) assert.equal(await h.store.put(`s${n}`, null, data({ active: false, secret: '', pending: undefined })), true)
    assert.equal(await h.store.put('limit', null, data({ active: false })), false)
    f.advance(86400001)
    assert.equal(await h.store.put('after-prune', null, data({ nextAt: f.time })), true)
    assert.equal(f.db.prepare('SELECT count(*) n FROM agent_app_mcp_events').get().n, 1)
  } finally { f.close() }
})

test('earliest durable wake wins and a concurrent wake survives an active drain', async () => {
  const f = fixture()
  try {
    const h = f.host()
    assert.equal(await h.ready(), false)
    await h.wake(f.time); await h.wake(f.time + 60000)
    assert.equal(f.db.prepare('SELECT due_at FROM agent_app_mcp_event_worker').get().due_at, f.time)
    let drained = 0
    await h.run(async () => {
      drained++
      assert.equal(await f.host().run(async () => { throw new Error('double-drain') }), null)
      await h.wake(f.time + 1000)
    })
    assert.equal(drained, 1); assert.equal(await h.ready(), true)
    assert.equal(f.db.prepare('SELECT due_at FROM agent_app_mcp_event_worker').get().due_at, f.time + 1000)
    f.advance(150001); assert.equal(await h.ready(), false)
  } finally { f.close() }
})

test('due index recovers commit-before-wake and expired worker leases after restart', async () => {
  const f = fixture()
  try {
    await f.host().store.put('s1', null, data()) // crash before wake()
    let h = f.reopen(), drained = 0
    await h.run(async () => { drained++ })
    assert.equal(drained, 1)
    f.db.prepare('UPDATE agent_app_mcp_event_worker SET lease_until=?, lease_token=?').run(f.time + 300000, 'dead-process')
    h = f.reopen()
    assert.equal(await h.run(async () => { drained++ }), null)
    f.advance(300001)
    await h.run(async () => { drained++ })
    assert.equal(drained, 2)
  } finally { f.close() }
})

test('drain connection failure propagates and can retry without rerunning a task', async () => {
  const f = fixture()
  try {
    const h = f.host(); await h.store.put('s1', null, data()); await h.wake(f.time)
    await assert.rejects(() => h.run(async () => { throw new Error('connection failed') }), /connection failed/)
    let attempts = 0
    const restarted = f.reopen()
    await restarted.run(async () => { attempts++; assert.equal((await restarted.store.get('s1')).data.pending.eventId, 'evt1') })
    assert.equal(attempts, 1)
  } finally { f.close() }
})

test('relay forwards signed bytes, not signing keys, and never treats transport failure as receipt', async () => {
  let request
  const relay = createMcpEventRelay({ url: 'https://id.tangle.tools/v1/mcp-events/egress', serviceName: 'gtm-agent', serviceToken: 'fixture-service-token',
    fetch: async (url, init) => { request = { url, init }; return new Response(JSON.stringify(init.method === 'GET' ? { version: 1, transport: 'pinned-public-https', configured: true } : { status: 503, body: '' })) } })
  assert.equal(await relay.ready(), true)
  const body = '{"eventId":"evt1"}', headers = { 'webhook-id': 'evt1', 'webhook-signature': 'v1,signed' }
  assert.deepEqual(await relay.post('https://callback.example/event', body, headers, AbortSignal.timeout(1000)), { status: 503, body: '' })
  const payload = JSON.parse(request.init.body)
  assert.equal(payload.body, body); assert.deepEqual(payload.headers, headers)
  assert.equal(request.init.redirect, 'error'); assert.equal(request.init.body.includes('fixture-service-token'), false)
  const unavailable = createMcpEventRelay({ url: 'https://id.tangle.tools/v1/mcp-events/egress', serviceName: 'gtm-agent', serviceToken: 'fixture', fetch: async () => new Response('', { status: 503 }) })
  assert.equal(await unavailable.ready(), false)
  await assert.rejects(() => unavailable.post('https://callback.example', body, headers, AbortSignal.timeout(1000)), /unavailable/)
})
