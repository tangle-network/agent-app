/** Standalone workerd + actual DO/SQLite/Router HTTP proof. No paid service is called.
 * AGENT_APP_STOP_CONSUMER_ROOT=<installed app with declared Wrangler> <app's tsx> <this file>
 * The consuming app owns the test runtime, as in stored-attachments-r2.integration.ts.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import type { DurableTurnLock } from '../../src/turn-stream/core'
import type { TurnCancellationIdentity } from '../../src/turn-stream/cancellation'

const transportOnly = process.argv.includes('--transport-only')
const consumerRoot = process.env.AGENT_APP_STOP_CONSUMER_ROOT
if (!consumerRoot) throw new Error('Set AGENT_APP_STOP_CONSUMER_ROOT to an installed consuming app with declared Wrangler')
const consumer = createRequire(resolve(consumerRoot, 'package.json'))
const appPackage = consumer('./package.json') as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
assert(appPackage.dependencies?.wrangler ?? appPackage.devDependencies?.wrangler, 'Consumer must declare Wrangler')
const wrangler = createRequire(consumer.resolve('wrangler/package.json'))
const productionConfig = readFileSync(resolve(consumerRoot, 'wrangler.toml'), 'utf8')
const compatibilityDate = productionConfig.match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1]
const flags = productionConfig.match(/^compatibility_flags\s*=\s*\[([\s\S]*?)\]/m)?.[1]
assert(compatibilityDate && flags, 'Consumer Wrangler config must name its compatibility date and flags')
const compatibilityFlags = [...flags.matchAll(/"([^"]+)"/g)].map(match => match[1]!)
const { Miniflare, convertV4MiniflareOptions } = wrangler('miniflare') as {
  convertV4MiniflareOptions(options: Record<string, unknown>): Record<string, unknown>
  Miniflare: new (options: Record<string, unknown>) => Runtime
}
interface Runtime {
  dispatchFetch(url: string, init?: RequestInit): Promise<Response>
  getD1Database(binding: string, workerName: string): Promise<{
    exec(sql: string): Promise<unknown>
    prepare(sql: string): { all<T>(): Promise<{ results: T[] }>; bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }> } }
  }>
  dispose(): Promise<void>
}
const directory = mkdtempSync(resolve(tmpdir(), 'agent-app-durable-stop-'))
const bundleDirectory = resolve(directory, 'bundle')
const workerEntry = transportOnly ? 'durable-stop.transport' : 'durable-stop.worker'
const bundlePath = resolve(bundleDirectory, `${workerEntry}.js`)
const checks: string[] = []
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function bounded<T>(promise: Promise<T>, label: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => { onTimeout?.(); reject(new Error(`Timed out: ${label}`)) }, 10_000)
  })]) } finally { clearTimeout(timer) }
}
function modelCase() {
  return { entered: deferred<void>(), admitted: deferred<void>(), aborted: deferred<void>(), settling: deferred<ServerResponse>(), released: deferred<void>(),
    releases: 0, releaseSignalAborted: undefined as boolean | undefined, complete: false }
}
let active = modelCase()
let nativeProbes = 0
const deferrals = new Map<string, { entered: ReturnType<typeof deferred<void>>; response: ReturnType<typeof deferred<void>>; claimed: boolean }>()
const peer = createServer((request, response) => {
  const path = new URL(request.url!, 'http://localhost').pathname
  let body = ''
  request.setEncoding('utf8').on('data', chunk => { body += chunk }).on('end', () => {
    if (path === '/deferral') {
      const executionId = new URL(request.url!, 'http://localhost').searchParams.get('executionId')!
      const barrier = deferrals.get(executionId)
      if (barrier && !barrier.claimed) {
        barrier.claimed = true; barrier.entered.resolve()
        void barrier.response.promise.then(() => response.end(JSON.stringify({ defer: false })))
      } else response.end(JSON.stringify({ defer: false }))
      return
    }
    if (path === '/native-probe' || path === '/native-session-probe') {
      nativeProbes++
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(path === '/native-probe' ? { status: 'absent' } : { reachable: true, terminal: true }))
      return
    }
    if (path === '/settlement') { active.settling.resolve(response); return }
    if (path === '/admitted') { active.admitted.resolve(); response.end('admitted'); return }
    if (path === '/released') {
      active.releases++; active.releaseSignalAborted = (JSON.parse(body) as { aborted: boolean }).aborted
      active.released.resolve(); response.end('released'); return
    }
    assert.equal(path, '/v1/chat/completions')
    const current = active
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ model: 'fixture/served', choices: [{ index: 0,
      delta: { reasoning_content: 'Reading the request.' }, finish_reason: null }] })}\n\n`)
    response.on('close', () => { if (!response.writableEnded) current.aborted.resolve() })
    current.entered.resolve()
    if (current.complete) response.end(`data: ${JSON.stringify({ model: 'fixture/served', choices: [{ index: 0,
      delta: { content: 'The request is complete.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
})
let modelUrl = ''
function start() {
  return new Miniflare(convertV4MiniflareOptions({ durableObjectsPersist: resolve(directory, 'objects'),
    d1Persist: resolve(directory, 'sqlite'), workers: [{ name: 'stop-fixture', modules: true, compatibilityDate,
      compatibilityFlags, scriptPath: bundlePath, modulesRoot: bundleDirectory,
      durableObjects: Object.fromEntries([['TURNS', 'FixtureTurnStream'], ['SHORT_TURNS', 'ShortTurnStream'],
        ['OUTAGE_TURNS', 'ControlOutageTurnStream'], ['DEFERRED_TURNS', 'DeferredTurnStream'], ['SHORT_DEFERRED_TURNS', 'ShortDeferredTurnStream'],
        ['BARRIER_TURNS', 'BarrierTurnStream']]
        .map(([binding, className]) => [binding, { className, useSQLite: true }])),
      d1Databases: { CHAT: 'chat' }, bindings: { MODEL_URL: modelUrl, TURN_STREAM_AUTH_SECRET: 'isolated-local-durable-stop-fixture-secret' },
    }] }))
}
let runtime: Runtime | undefined
const identity = (name: string): TurnCancellationIdentity => ({ workspaceId: 'workspace', threadId: name, scope: 'thread',
  executionId: `execution-${name}`, lockId: `lock-${name}`, turnStreamId: `stream-${name}` })
async function request(path: string, input: unknown, authorized: boolean | string = true) {
  const abort = new AbortController()
  const operation = (async () => {
    if (!runtime) throw new Error('The fixture runtime has not started')
    const response = await runtime.dispatchFetch(`http://fixture.test${path}`, { method: 'POST', signal: abort.signal, headers: {
      'content-type': 'application/json', ...(authorized ? { Authorization: `Bearer ${typeof authorized === 'string' ? authorized : 'fixture-authorized-member'}` } : {}),
    }, body: JSON.stringify(input) })
    // The turn intentionally streams until Stop; every other protocol response
    // must finish its body inside the same bound as its request headers.
    if (path === '/turn') return response
    const body = await response.arrayBuffer()
    return new Response(body.byteLength ? body : null, { status: response.status, headers: response.headers })
  })()
  return bounded(operation, `${path} response`, () => abort.abort(new Error(`Timed out: ${path} response`)))
}
async function json<T>(path: string, input: unknown): Promise<T> {
  return bounded((async () => {
    const response = await request(path, input)
    const body = await response.text()
    assert.equal(response.status, 200, `${path}: ${body}`)
    return JSON.parse(body) as T
  })(), `${path} JSON body`)
}
async function peek(input: TurnCancellationIdentity, query = '') {
  return (await json<{ active: DurableTurnLock | null }>(`/peek${query}`, input)).active
}
async function acquire(input: TurnCancellationIdentity, query = '') {
  const result = await json<{ acquired: boolean }>(`/lock${query}`, input)
  assert(result.acquired, 'Fixture must acquire the actual durable lock')
}
let primaryFailed = false
try {
  // The consuming app's Wrangler owns Node compatibility, including bare
  // builtin imports. Its dry-run build is also the maintained test harness's
  // prebuilt-worker path; it performs no upload or production resource access.
  const configPath = resolve(directory, 'wrangler.json')
  writeFileSync(configPath, JSON.stringify({ name: 'stop-fixture',
    main: fileURLToPath(new URL(`./${workerEntry}.ts`, import.meta.url)),
    compatibility_date: compatibilityDate, compatibility_flags: compatibilityFlags, send_metrics: false }))
  execFileSync(process.execPath, [consumer.resolve('wrangler'), 'deploy', '--dry-run',
    '--config', configPath, '--outdir', bundleDirectory], { cwd: directory,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, timeout: 60_000, encoding: 'utf8', stdio: 'pipe' })
  await new Promise<void>((ready, reject) => {
    peer.once('error', reject)
    peer.listen(0, '127.0.0.1', () => { peer.removeListener('error', reject); ready() })
  })
  const address = peer.address()
  assert(address && typeof address === 'object')
  modelUrl = `http://127.0.0.1:${address.port}`
  runtime = start()
  let database = await runtime.getD1Database('CHAT', 'stop-fixture')
  await database.exec('CREATE TABLE messages(id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, content TEXT, parts TEXT);\nCREATE TABLE effects(turn_id TEXT, code TEXT);\nCREATE TABLE owner_evidence(workspace_id TEXT, thread_id TEXT, scope TEXT, execution_id TEXT, lock_id TEXT, turn_stream_id TEXT PRIMARY KEY, status TEXT);\nCREATE TABLE child_holds(execution_id TEXT PRIMARY KEY, lock_id TEXT, turn_stream_id TEXT, status TEXT);')
  await database.exec("CREATE TABLE members(token TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT, role TEXT);\nINSERT INTO members VALUES ('fixture-authorized-member','member','workspace','editor'),('viewer-member','viewer','workspace','viewer'),('foreign-editor','foreign','other-workspace','editor');\nCREATE TABLE threads(id TEXT PRIMARY KEY, workspace_id TEXT);\nINSERT INTO threads VALUES ('route-stop','workspace'),('route-transport-loss','workspace'),('route-external-release','workspace'),('route-complete','workspace');\nCREATE TABLE control_targets(thread_id TEXT PRIMARY KEY, client_turn_id TEXT, metadata TEXT);\nCREATE TABLE target_reads(thread_id TEXT, kind TEXT);\nCREATE TABLE forbidden_effects(kind TEXT);")
  const replay = identity('replay')
  await acquire(replay)
  assert.deepEqual(await json('/stop', replay), { requested: true })
  assert((await peek(replay))?.cancellation?.requestedAt, 'Durable cancellation intent must persist before acknowledgement')
  // Restart the actual storage process: no isolate memory can carry this request into the next owner connection.
  await runtime.dispose(); runtime = start()
  database = await runtime.getD1Database('CHAT', 'stop-fixture')
  assert.deepEqual(await json('/observe', replay), { aborted: true })
  assert.equal((await peek(replay))?.lockId, replay.lockId, 'Closing the owner connection cannot release the lock')
  assert.deepEqual(await json('/release', replay), { released: true })
  checks.push('durable cancellation survives runtime restart and owner disconnect')

  if (!transportOnly) {
    const racing = identity('racing')
    await acquire(racing)
    assert.deepEqual(await json('/observe-race', racing), { aborted: true })
    assert.deepEqual(await json('/release', racing), { released: true })
    const beforeSync = identity('before-sync')
    await acquire(beforeSync)
    assert.deepEqual(await json('/observe-before-sync', beforeSync), { aborted: true })
    assert.deepEqual(await json('/release', beforeSync), { released: true })
    checks.push('Stop during connection and after upgrade before sync reaches the owner')

    const disconnected = identity('disconnected')
    await acquire(disconnected)
    assert.deepEqual(await json('/observe', disconnected), { aborted: false })
    assert.equal((await peek(disconnected))?.lockId, disconnected.lockId)
    await json('/stop', disconnected)
    assert.deepEqual(await json('/observe', disconnected), { aborted: true })
    await json('/release', disconnected)
    const successor = { ...disconnected, executionId: 'new-execution', lockId: 'new-lock', turnStreamId: 'new-stream' }
    await acquire(successor)
    assert.deepEqual(await json('/stop', disconnected), { requested: false, reason: 'stale-owner' })
    assert.equal((await peek(successor))?.cancellation?.requestedAt, undefined)
    assert.equal((await request('/observe', disconnected)).status, 409, 'An old exact owner cannot connect to a successor')
    await json('/release', successor)
    checks.push('stale Stop and stale control identity cannot affect a successor')

    const expired = identity('expired')
    await acquire(expired, '?short=1'); await json('/stop?short=1', expired)
    await delay(1100)
    const afterExpiry = { ...expired, executionId: 'expiry-successor', lockId: 'expiry-lock', turnStreamId: 'expiry-stream' }
    await acquire(afterExpiry, '?short=1')
    assert.deepEqual(await json('/stop?short=1', expired), { requested: false, reason: 'stale-owner' })
    assert.equal((await peek(afterExpiry, '?short=1'))?.cancellation?.requestedAt, undefined)
    await json('/release?short=1', afterExpiry)
    checks.push('existing lock expiry admits a successor after a cancelled owner crashes')

    const pruneTrigger = identity('prune-external-read')
    await acquire(pruneTrigger, '?barrier=1')
    await delay(1100)
    const pruneBarrier = { entered: deferred<void>(), response: deferred<void>(), claimed: false }
    deferrals.set(pruneTrigger.executionId, pruneBarrier)
    const competing = identity('competing-target')
    const firstAcquire = json<{ acquired: boolean }>('/lock?barrier=1', competing)
    void firstAcquire.catch(() => {})
    try {
      await bounded(pruneBarrier.entered.promise, 'expired other-thread ownership read')
      const winner = { ...competing, executionId: 'competing-winner', lockId: 'competing-winner-lock', turnStreamId: 'competing-winner-stream' }
      await acquire(winner, '?barrier=1')
      pruneBarrier.response.resolve()
      assert.equal((await firstAcquire).acquired, false, 'An acquire delayed by other-thread pruning cannot overwrite the winning owner')
      assert.equal((await peek(winner, '?barrier=1'))?.lockId, winner.lockId)
      await json('/release?barrier=1', winner)
    } finally { pruneBarrier.response.resolve(); deferrals.delete(pruneTrigger.executionId) }
    checks.push('external pruning read admits exactly one competing target owner without overwriting its generation')

    const delayedExpiry = identity('delayed-expiry-read')
    await acquire(delayedExpiry, '?barrier=1')
    await delay(1100)
    const expiryBarrier = { entered: deferred<void>(), response: deferred<void>(), claimed: false }
    deferrals.set(delayedExpiry.executionId, expiryBarrier)
    const delayedRead = peek(delayedExpiry, '?barrier=1')
    void delayedRead.catch(() => {})
    try {
      await bounded(expiryBarrier.entered.promise, 'old generation expiry observation')
      assert.equal(await peek(delayedExpiry, '?barrier=1'), null)
      // The public adapter permits explicitly reused ids. The lease generation,
      // rather than only those ids, must fence a delayed expiry observation.
      await acquire(delayedExpiry, '?barrier=1')
      const successorStart = (await peek(delayedExpiry, '?barrier=1'))!.startedAt
      await delay(1100)
      expiryBarrier.response.resolve()
      assert.equal((await delayedRead)?.startedAt, successorStart, 'A delayed expiry verdict cannot delete a successor lease with reused identity')
      assert.equal((await json<{ active: DurableTurnLock }>('/raw-lock?barrier=1', delayedExpiry)).active.startedAt, successorStart)
      assert.equal(await peek(delayedExpiry, '?barrier=1'), null, 'A fresh observation may reclaim the now-expired successor')
    } finally { expiryBarrier.response.resolve(); deferrals.delete(delayedExpiry.executionId) }
    checks.push('delayed expiry cannot delete a successor lease even when caller ids are reused')

    const heldAcrossExpiry = identity('child-across-expiry')
    const heldQuery = '?deferred=1&short=1'
    await acquire(heldAcrossExpiry, heldQuery)
    const originalExpiry = (await peek(heldAcrossExpiry, heldQuery))!.expiresAt
    await json('/hold-child', heldAcrossExpiry)
    await json(`/stop${heldQuery}`, heldAcrossExpiry)
    await delay(1100)
    assert.equal((await peek(heldAcrossExpiry, heldQuery))?.lockId, heldAcrossExpiry.lockId)
    assert.equal((await peek(heldAcrossExpiry, heldQuery))?.expiresAt, originalExpiry, 'Child deferral never rewrites the expiry clock')
    assert.equal((await json<{ acquired: boolean }>(`/lock${heldQuery}`, { ...heldAcrossExpiry, executionId: 'blocked', lockId: 'blocked' })).acquired, false)
    const unrelated = identity('expiry-prune-trigger')
    await acquire(unrelated, heldQuery)
    assert.equal((await peek(heldAcrossExpiry, heldQuery))?.lockId, heldAcrossExpiry.lockId, 'Pruning another thread cannot drop a registered child hold')
    await json(`/release${heldQuery}`, unrelated)
    await json('/hold-child', { ...heldAcrossExpiry, childStatus: 'unknown' })
    assert.equal((await peek(heldAcrossExpiry, heldQuery))?.lockId, heldAcrossExpiry.lockId)
    await json('/hold-child', { ...heldAcrossExpiry, childStatus: 'read-error' })
    assert.equal((await request(`/peek${heldQuery}`, heldAcrossExpiry)).status, 503, 'A real child ownership read error cannot become absence')
    assert.equal((await json<{ active: DurableTurnLock }>(`/raw-lock${heldQuery}`, heldAcrossExpiry)).active.lockId, heldAcrossExpiry.lockId)
    await json('/clear-child', heldAcrossExpiry)
    const childSuccessor = { ...heldAcrossExpiry, executionId: 'child-successor', lockId: 'child-successor-lock', turnStreamId: 'child-successor-stream' }
    await acquire(childSuccessor, heldQuery)
    assert.deepEqual(await json(`/stop${heldQuery}`, heldAcrossExpiry), { requested: false, reason: 'stale-owner' })
    await json(`/release${heldQuery}`, childSuccessor)
    checks.push('registered durable child, unknown state and read error hold across expiry until exact clear; cancellation alone does not')

    const deferredOwner = identity('deferred')
    await acquire(deferredOwner, '?deferred=1')
    await json('/hold-child', deferredOwner)
    assert.deepEqual(await json('/release?deferred=1', deferredOwner), { released: false, deferred: true })
    assert.deepEqual(await json('/stop?deferred=1', deferredOwner), { requested: true })
    assert.deepEqual(await json('/observe?deferred=1', deferredOwner), { aborted: true })
    assert.equal((await peek(deferredOwner, '?deferred=1'))?.lockId, deferredOwner.lockId)
    await json('/owner-evidence', { ...deferredOwner, ownerStatus: 'abandoned' })
    assert.equal((await json<{ released: boolean }>('/recover?deferred=1', deferredOwner)).released, false, 'A child hold vetoes otherwise abandoned owner recovery')
    await json('/clear-child', { ...deferredOwner, lockId: 'stale-child-parent' })
    assert.equal((await json<{ released: boolean }>('/recover?deferred=1', deferredOwner)).released, false, 'A stale child acknowledgement cannot clear the parent hold')
    await json('/clear-child', deferredOwner)
    assert.equal((await json<{ released: boolean }>('/recover?deferred=1', deferredOwner)).released, true)
    checks.push('scoped child deferral vetoes recovery until cleared; deferred Stop delivery remains effective')

    const abandoned = identity('abandoned')
    await acquire(abandoned)
    assert.equal((await json<{ released: boolean }>('/recover', abandoned)).released, false, 'Absent owner evidence stays unknown')
    await json('/owner-evidence', { ...abandoned, ownerStatus: 'live' })
    assert.equal((await json<{ released: boolean }>('/recover', abandoned)).released, false, 'A live owner cannot be recovered')
    await json('/owner-evidence', { ...abandoned, lockId: 'different-owner', ownerStatus: 'abandoned' })
    assert.equal((await json<{ released: boolean }>('/recover', abandoned)).released, false, 'A terminal row for another generation is unknown')
    await json('/owner-evidence', { ...abandoned, ownerStatus: 'abandoned' })
    assert.equal((await json<{ released: boolean }>('/recover-with-control', abandoned)).released, false, 'An actual exact owner socket vetoes recovery')
    await json('/close', abandoned)
    assert.equal((await json<{ released: boolean }>('/recover', abandoned)).released, true, 'Confirmed quiescent owner recovers without waiting for lock expiry')
    const recoveredSuccessor = { ...abandoned, executionId: 'recovered-execution', lockId: 'recovered-lock', turnStreamId: 'recovered-stream' }
    await acquire(recoveredSuccessor)
    assert.deepEqual(await json('/recover-exact', abandoned), { released: false })
    assert.equal((await peek(recoveredSuccessor))?.lockId, recoveredSuccessor.lockId)
    await json('/release', recoveredSuccessor)
    const graceOwner = identity('grace')
    await acquire(graceOwner)
    await json('/owner-evidence', { ...graceOwner, ownerStatus: 'abandoned' })
    assert.equal((await json<{ released: boolean }>('/recover?grace=1', graceOwner)).released, false)
    await delay(1100)
    assert.equal((await json<{ released: boolean }>('/recover?grace=1', graceOwner)).released, true)
    assert.equal(nativeProbes, 0, 'Native-only probes cannot certify an outer Router owner abandoned')
    checks.push('exact tri-state owner proof, existing grace, live socket veto and successor fencing govern recovery')

    const native = identity('non-adopting-native')
    assert.equal((await json<{ acquired: boolean }>('/native-lock', native)).acquired, true)
    assert.equal((await peek(native))?.cancellation, undefined)
    assert.deepEqual(await json('/stop', native), { requested: false, reason: 'stale-owner' })
    assert.deepEqual(await json('/legacy-interrupt', native), { released: true })
    checks.push('non-adopting native locks retain existing interrupted release behavior')

    const outage = identity('setup-outage')
    assert.equal((await json<{ failed: boolean }>('/setup-failure?outage=1', outage)).failed, true)
    assert.equal(await peek(outage, '?outage=1'), null)
    await acquire(outage, '?outage=1'); await json('/release?outage=1', outage)
    assert.equal((await request('/stop', replay, false)).status, 401)
    assert.equal((await request('/raw-unauthenticated', replay)).status, 401)
    assert.equal((await request('/cross-channel', replay)).status, 401)
    checks.push('setup outage cleans the exact lock; product and channel authentication fail closed')

    const authority = identity('control-authority')
    await acquire(authority)
    assert.deepEqual(await json('/viewer-control', authority), { status: 401 }, 'A valid channel viewer token plus exact owner coordinates cannot become the owner')
    assert.deepEqual(await json('/wrong-identity-control', authority), { status: 401 })
    assert.deepEqual(await json('/wrong-purpose-control', authority), { status: 401 })
    assert.deepEqual(await json('/viewer', authority), { status: 101 }, 'Normal viewer upgrades retain legacy capability behavior')
    assert.equal((await request('/viewer-stop', authority)).status, 401)
    assert.equal((await request('/viewer-recover', authority)).status, 401)
    assert.deepEqual(await json('/observe', authority), { aborted: false }, 'The server purpose and exact identity capability can establish owner control')
    await json('/stop', authority)
    assert.deepEqual(await json('/observe', authority), { aborted: true })
    await json('/release', authority)
    checks.push('server purpose and exact identity claims separate owner control, Stop and recovery from legacy viewer capabilities')

    for (const purpose of ['turn-control', 'turn-cancel', 'turn-recovery']) {
      const scoped = identity(`purpose-${purpose}`)
      await acquire(scoped)
      for (const operation of ['acquire', 'release', 'interrupt', 'status', 'product', 'viewer']) {
        assert.deepEqual(await json(`/purpose-capability?purpose=${purpose}&operation=${operation}`, scoped), { status: 401 },
          'A purpose-bound capability cannot authorize a legacy channel operation')
        assert.equal((await peek(scoped))?.lockId, scoped.lockId)
      }
      await json('/release', scoped)
    }
    checks.push('all three purpose capabilities reject six legacy mutation, product and viewer operations without changing ownership')

    let expectedEffects = 0
    for (const mode of ['stop', 'transport-loss', 'external-release', 'complete'] as const) {
      active = modelCase()
      active.complete = mode === 'complete'
      const thread = `route-${mode}`
      const clientTurnId = `client-${thread}`
      const response = await bounded(request('/turn', { threadId: thread, turnId: clientTurnId, content: 'Read my request.' }), 'route response')
      assert.equal(response.status, 200)
      const wire = response.text()
      // Observe rejection at creation even while the scenario is waiting for
      // admission/settlement; its deciding await below still reports the error.
      void wire.catch(() => {})
      await bounded(active.entered.promise, 'real Router model request')
      await bounded(active.admitted.promise, 'actual lock/control and captured target registration')
      const lock = await peek(identity(thread))
      assert(lock?.cancellation)
      const owner: TurnCancellationIdentity = { ...lock, turnStreamId: lock.cancellation.turnStreamId }
      const readTarget = async () => {
        const rows = await database.prepare('SELECT metadata FROM control_targets WHERE thread_id = ?').bind(thread).all<{ metadata: string }>()
        assert(rows.results[0], 'Admission must persist the exact captured target before its output commits')
        return JSON.parse(rows.results[0].metadata) as TurnCancellationIdentity & { dispatchToken: string; responseStatus: string }
      }
      const target = await readTarget()
      assert.equal(target.lockId, owner.lockId)
      assert.equal(target.executionId, owner.executionId)
      assert.equal(target.turnStreamId, owner.turnStreamId)
      const stopRequest = { threadId: thread, turnId: clientTurnId, cancellationToken: target.dispatchToken,
        // A caller's coordinates are not target authority; the existing target owner must ignore these.
        workspaceId: 'forged-workspace', executionId: 'forged-execution', lockId: 'forged-lock', turnStreamId: 'forged-stream' }
      const successor = { ...owner, executionId: 'external-successor', lockId: 'external-successor-lock', turnStreamId: 'external-successor-stream' }
      if (mode === 'stop') {
        assert.equal((await request('/cancel', stopRequest, false)).status, 401)
        assert.equal((await request('/cancel', stopRequest, 'viewer-member')).status, 403)
        assert.equal((await request('/cancel', stopRequest, 'foreign-editor')).status, 403)
        assert.equal((await database.prepare('SELECT kind FROM target_reads WHERE thread_id = ?').bind(thread).all()).results.length, 0,
          'Shared authorization must refuse callers before resolving their target')
        assert.equal((await request('/cancel', { ...stopRequest, cancellationToken: 'old-dispatch' })).status, 409)
        assert.equal((await peek(owner))?.cancellation?.requestedAt, undefined)
        assert.deepEqual(await json('/cancel', stopRequest), { succeeded: true, sandboxInterrupted: false, cancellationRequested: true })
        assert.deepEqual(await json('/cancel', stopRequest), { succeeded: true, sandboxInterrupted: false, cancellationRequested: true }, 'Repeated Stop is idempotent')
        assert.equal((await readTarget()).responseStatus, 'running', 'Intent is not confirmed native completion or stopped metadata')
        assert.deepEqual(await json('/legacy-interrupt', owner), { released: false }, 'Legacy interrupt cannot release a cancellable producer early')
      } else if (mode === 'transport-loss') await json('/close', owner)
      else if (mode === 'external-release') {
        assert.deepEqual(await json('/release', owner), { released: true })
        await acquire(successor)
        assert.equal((await request('/cancel', stopRequest)).status, 409, 'The captured old target cannot request Stop for its successor')
        assert.equal((await peek(successor))?.cancellation?.requestedAt, undefined)
      }
      if (mode !== 'complete') await bounded(active.aborted.promise, 'effective signal closes actual producer HTTP I/O')
      const settlement = await bounded(active.settling.promise, 'terminal lifecycle effect')
      assert.equal((await peek(owner))?.lockId, mode === 'external-release' ? successor.lockId : lock.lockId, 'Only an external exact release can remove the owner during settlement')
      assert.equal((await json<{ acquired: boolean }>('/lock', { ...owner, executionId: 'conflict', lockId: 'conflict' })).acquired, false)
      settlement.end('settled')
      await bounded(active.released.promise, 'cooperative exact release')
      assert((await bounded(wire, 'terminal wire')).includes(mode === 'complete' ? 'The request is complete.' : 'turn_aborted'))
      assert.deepEqual(await json('/status', owner), { status: mode === 'complete' ? 'complete' : 'error' })
      assert.equal(active.releases, 1, 'Cooperative release runs once')
      assert.equal(active.releaseSignalAborted, mode !== 'complete', 'Normal completion closes control before release without self-aborting')
      if (mode === 'external-release') {
        assert.equal((await peek(successor))?.lockId, successor.lockId, 'The old cooperative release cannot remove its successor')
        await json('/release', successor)
      }
      assert.equal(await peek(owner), null)
      assert.deepEqual(await json('/sockets', owner), { open: 0 })
      const effects = await database.prepare('SELECT code FROM effects ORDER BY rowid').all<{ code: string }>()
      assert.equal(effects.results.length, ++expectedEffects, 'Exactly one terminal effect per route')
      assert.equal(effects.results.at(-1)?.code, mode === 'complete' ? 'complete' : mode === 'stop' ? 'turn_cancel_requested' : 'turn_control_unavailable')
      assert.equal((await readTarget()).responseStatus, mode === 'complete' ? 'answered' : 'error')
      assert.equal((await database.prepare('SELECT kind FROM target_reads WHERE kind = ?').bind('observation').all()).results.length, 0,
        'Durable control cannot add a metadata polling observer')
      assert.equal((await database.prepare('SELECT kind FROM forbidden_effects').all()).results.length, 0,
        'A requested-only control target must never invoke stopped metadata CAS')
      checks.push(`${mode}: actual producer I/O, terminal status, one settlement/release and exact successor ownership`)
    }
  }
  console.log(JSON.stringify({ checks, consumerRoot, scope: transportOnly ? 'transport-only' : 'complete-product-route',
    consumerRevision: execFileSync('git', ['-C', consumerRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    consumerLockSha256: createHash('sha256').update(readFileSync(resolve(consumerRoot, 'pnpm-lock.yaml'))).digest('hex'),
    miniflareEntry: realpathSync(wrangler.resolve('miniflare')), wranglerEntry: dirname(consumer.resolve('wrangler/package.json')),
    compatibilityDate, compatibilityFlags, builder: 'consumer-wrangler-dry-run',
    actualDO: true, actualSQLite: true, actualRouterHTTP: !transportOnly, paidCalls: 0 }))
} catch (error) {
  primaryFailed = true
  throw error
} finally {
  const cleanupErrors: unknown[] = []
  try {
    // Stop accepting before aborting existing calls: their lifecycle failure
    // must not open another held settlement request during runtime disposal.
    const peerClosed = new Promise<void>((resolve, reject) => {
      if (!peer.listening) { resolve(); return }
      peer.close(error => error ? reject(error) : resolve())
    })
    peer.closeAllConnections()
    const disposed = Promise.resolve().then(() => runtime?.dispose())
    const results = await Promise.allSettled([
      bounded(disposed, 'Miniflare disposal'), bounded(peerClosed, 'HTTP peer closure'),
    ])
    for (const result of results) if (result.status === 'rejected') cleanupErrors.push(result.reason)
  } catch (error) { cleanupErrors.push(error) }
  finally {
    try { rmSync(directory, { recursive: true, force: true }) }
    catch (error) { cleanupErrors.push(error) }
  }
  if (cleanupErrors.length) {
    if (primaryFailed) console.error('Durable Stop cleanup also failed:', cleanupErrors.map(error => error instanceof Error ? error.message : String(error)))
    else throw new AggregateError(cleanupErrors, 'Durable Stop fixture cleanup failed')
  }
}
