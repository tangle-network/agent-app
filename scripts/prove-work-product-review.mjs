/** Real HTTP, two SQLite connections and the shared review service. No model or provider calls. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createWorkProductService } from '../src/work-product/service.ts'
import { createWorkProductRoutes } from '../src/work-product/route.ts'

const baseline = process.argv.includes('--baseline')
const directory = await mkdtemp(path.join(os.tmpdir(), 'work-product-review-'))
const file = path.join(directory, 'records.sqlite')
const first = new DatabaseSync(file)
first.exec('CREATE TABLE records (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE events (body TEXT NOT NULL)')
const second = new DatabaseSync(file)
const observations = []

// Persistence fixture only: the production service owns every state transition and history entry.
function store(connection) {
  const load = (id) => {
    const row = connection.prepare('SELECT body FROM records WHERE id = ?').get(id)
    return row ? JSON.parse(row.body) : null
  }
  return {
    async load(id) { return load(id) },
    async insert(record) {
      connection.prepare('INSERT INTO records VALUES (?, ?)').run(record.id, JSON.stringify(record))
      return load(record.id)
    },
    async update(id, guard, patch) {
      const row = connection.prepare(`
        UPDATE records SET body = json_patch(body, ?)
        WHERE id = ? AND (? IS NULL OR json_extract(body, '$.status') = ?)
          AND (? IS NULL OR json_extract(body, '$.version') = ?)
        RETURNING body
      `).get(JSON.stringify(patch), id, guard.status ?? null, guard.status ?? null,
        guard.version ?? null, guard.version ?? null)
      return row ? JSON.parse(row.body) : null
    },
    async listByWorkspace(workspaceId, options) {
      return connection.prepare("SELECT body FROM records WHERE json_extract(body, '$.workspaceId') = ?")
        .all(workspaceId).map(row => JSON.parse(row.body))
        .filter(record => !options?.status || options.status.includes(record.status))
    },
    async findDraft(workspaceId, scopeKey) {
      return (await this.listByWorkspace(workspaceId, { status: ['draft', 'blocked'] }))
        .find(record => record.scopeKey === scopeKey) ?? null
    },
    async appendEvent(event) {
      connection.prepare('INSERT INTO events VALUES (?)').run(JSON.stringify(event))
    },
  }
}
const normal = store(first)
const other = createWorkProductService({ store: store(second) })
const provenance = (version) => ({ profileHash: `fixture-profile-${version}`, runId: `fixture-run-${version}`,
  servingModels: [], producedAt: version })
const submission = (version) => ({ artifact: { kind: 'document', title: `Draft ${version}`, content: `Body ${version}` },
  checks: [], provenance: provenance(version) })
function unwrap(result) {
  assert.equal(result.succeeded, true, result.error)
  return result.value
}
async function draft(id) {
  return other.create({ id, workspaceId: 'workspace', threadId: 'thread', scopeKey: id, provenance: provenance(1) })
}
async function ready(id) {
  await draft(id)
  return unwrap(await other.submit(id, submission(1)))
}
async function correct(id, finish = true) {
  unwrap(await other.applyVerdict(id, { verdict: 'request_changes', reviewedBy: 'reviewer-b', note: 'Correct the document' }))
  unwrap(await other.reopen(id))
  if (finish) unwrap(await other.submit(id, submission(2)))
}
function pauseNextRead(id) {
  let announce, release
  const reached = new Promise(resolve => { announce = resolve })
  const resume = new Promise(resolve => { release = resolve })
  let armed = true
  return { reached, release, port: {
    ...normal,
    async load(key) {
      const record = await normal.load(key)
      if (armed && key === id) { armed = false; announce(); await resume }
      return record
    },
  } }
}
const counts = { verdict: 0, export: 0 }
let activeStore = normal
const routedStore = Object.fromEntries(Object.keys(normal).map(name => [name, (...args) => activeStore[name](...args)]))
const routes = createWorkProductRoutes({
  store: routedStore,
  authorize: async ({ request }) => request.headers.get('authorization') === 'Bearer fixture-reviewer'
    ? { ok: true, workspaceId: 'workspace', reviewedBy: 'reviewer-a' }
    : { ok: false, response: new Response(null, { status: 401 }) },
  onVerdict: () => { counts.verdict++ },
  onExport: () => { counts.export++ },
})
const server = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const incoming = new Request(`http://127.0.0.1${request.url}`, {
      method: request.method, headers: request.headers,
      ...(request.method === 'POST' ? { body } : {}),
    })
    const result = request.method === 'POST'
      ? await routes.verdict(incoming)
      : await routes.detail(incoming, new URL(incoming.url).searchParams.get('id'))
    response.writeHead(result.status, Object.fromEntries(result.headers))
    response.end(Buffer.from(await result.arrayBuffer()))
  } catch (error) {
    response.writeHead(500); response.end(String(error))
  }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
async function post(id, fields = {}, authorized = true) {
  const response = await fetch(origin, { method: 'POST', headers: {
    'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer fixture-reviewer' } : {}),
  }, body: JSON.stringify({ id, verdict: 'approve', ...fields }) })
  return { status: response.status, body: await response.json().catch(() => null) }
}
async function check(name, run) {
  await run()
  observations.push(name)
}
try {
  await check('reviewed v1 cannot approve the same record after a real correction to v2', async () => {
    await ready('stale-client')
    const viewed = await fetch(`${origin}?id=stale-client`, { headers: { authorization: 'Bearer fixture-reviewer' } })
    const oldVersion = (await viewed.json()).workProduct.version
    await correct('stale-client')
    const result = await post('stale-client', { version: oldVersion })
    assert.equal(result.status, baseline ? 200 : 409)
    assert.equal((await normal.load('stale-client')).status, baseline ? 'approved' : 'ready')
    if (!baseline) {
      assert.equal(counts.verdict, 0)
      assert.equal(counts.export, 0)
      const approval = await post('stale-client', { version: 2 })
      assert.equal(approval.status, 200)
      const history = approval.body.workProduct.history.at(-1)
      assert.equal(history.version, 2)
      assert.equal(history.provenance.runId, 'fixture-run-2')
      assert.equal((await post('stale-client', { version: 2 })).status, 409)
      assert.deepEqual(counts, { verdict: 1, export: 1 })
    }
  })

  await check('in-flight review retains its original read across correction and resubmission', async () => {
    await ready('review-race')
    const pause = pauseNextRead('review-race')
    const service = createWorkProductService({ store: pause.port })
    const operation = service.applyVerdict('review-race', { verdict: 'approve', reviewedBy: 'reviewer-a', expectedVersion: 1 })
    await pause.reached
    await correct('review-race')
    const intact = await normal.load('review-race')
    pause.release()
    const result = await operation
    assert.equal(result.succeeded, baseline)
    const after = await normal.load('review-race')
    if (baseline) {
      assert.equal(after.version, 2)
      assert.equal(after.history.at(-1).version, 1)
    } else {
      assert.equal(result.conflict, true)
      assert.deepEqual(after, intact)
    }
  })

  await check('an old submit cannot overwrite a new correction draft', async () => {
    await draft('submit-race')
    const pause = pauseNextRead('submit-race')
    const service = createWorkProductService({ store: pause.port })
    const operation = service.submit('submit-race', submission(1))
    await pause.reached
    unwrap(await other.submit('submit-race', submission(1)))
    await correct('submit-race', false)
    const intact = await normal.load('submit-race')
    pause.release()
    const result = await operation
    assert.equal(result.succeeded, baseline)
    const after = await normal.load('submit-race')
    if (baseline) assert.equal(after.history.at(-1).version, 1)
    else { assert.equal(result.conflict, true); assert.deepEqual(after, intact) }
  })

  await check('legacy requests still fence the route snapshot through service admission', async () => {
    await ready('route-race')
    const pause = pauseNextRead('route-race')
    activeStore = pause.port
    const operation = post('route-race')
    await pause.reached
    await correct('route-race')
    const intact = await normal.load('route-race')
    pause.release()
    const result = await operation
    assert.equal(result.status, baseline ? 200 : 409)
    if (!baseline) assert.deepEqual(await normal.load('route-race'), intact)
    activeStore = normal
  })

  if (!baseline) {
    await check('invalid versions fail before mutation and authorization remains required', async () => {
      await ready('validation')
      const intact = await normal.load('validation')
      for (const version of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal((await post('validation', { version })).status, 400)
      }
      assert.equal((await post('validation', { version: 1 }, false)).status, 401)
      assert.deepEqual(await normal.load('validation'), intact)
      assert.equal((await post('validation')).status, 200)
    })
    await check('conflicting reviewers create one durable verdict and no duplicate hook', async () => {
      await ready('concurrent')
      const old = { ...counts }
      const results = await Promise.all([post('concurrent', { version: 1 }), post('concurrent', {
        version: 1, verdict: 'request_changes', note: 'Another review',
      })])
      assert.deepEqual(results.map(r => r.status).sort(), [200, 409])
      assert.equal(counts.verdict, old.verdict + 1)
      const record = await normal.load('concurrent')
      assert.equal(record.history.filter(h => h.status === 'approved' || h.status === 'changes_requested').length, 1)
    })
    await check('guarded status operations preserve normal corrections and prior-version supersession', async () => {
      await ready('older')
      unwrap(await other.applyVerdict('older', { verdict: 'approve', reviewedBy: 'reviewer-a', expectedVersion: 1 }))
      await other.create({ id: 'newer', workspaceId: 'workspace', threadId: 'thread', scopeKey: 'older', version: 2, provenance: provenance(2) })
      unwrap(await other.submit('newer', submission(2)))
      unwrap(await other.applyVerdict('newer', { verdict: 'approve', reviewedBy: 'reviewer-a', expectedVersion: 2 }))
      assert.equal((await normal.load('older')).status, 'superseded')
      assert.equal((await normal.load('newer')).status, 'approved')
      unwrap(await other.supersede('newer'))
      assert.equal((await normal.load('newer')).status, 'superseded')
    })
  }
  console.log(JSON.stringify({ passed: true, mode: baseline ? 'baseline-defect-reproduction' : 'corrected-behavior', observations,
    providerCalls: 0, scope: 'Real shared review service/routes over loopback HTTP and two SQLite connections; constructed documents and reviewer identity. Not a deployed app or semantic-quality proof.' }, null, 2))
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  second.close(); first.close()
  await rm(directory, { recursive: true, force: true })
}
