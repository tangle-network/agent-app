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
import { settleTurnResponse, TURN_HOST_CONTROL_HEADER, TURN_HOST_CONTROL_FIRST,
  isTurnHostControlEvent, type TurnHostControlTarget } from '../../src/chat-routes/turn-progress'

const transportOnly = process.argv.includes('--transport-only')
const consumerRoot = process.env.AGENT_APP_STOP_CONSUMER_ROOT
if (!consumerRoot) throw new Error('Set AGENT_APP_STOP_CONSUMER_ROOT to an installed consuming app with declared Wrangler')
const consumer = createRequire(resolve(consumerRoot, 'package.json'))
const appPackage = consumer('./package.json') as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
assert(appPackage.dependencies?.wrangler ?? appPackage.devDependencies?.wrangler, 'Consumer must declare Wrangler')
const wrangler = createRequire(consumer.resolve('wrangler/package.json'))
const consumerLock = readFileSync(resolve(consumerRoot, 'pnpm-lock.yaml'))
const lockedWrangler = consumerLock.toString().match(/^ {6}wrangler:\n {8}specifier:[^\n]*\n {8}version: ([^\s(]+)/m)?.[1]
const installedWrangler = (wrangler('./package.json') as { version: string }).version
assert(lockedWrangler && installedWrangler === lockedWrangler,
  `Unsupported consumer toolchain: installed Wrangler ${installedWrangler}, frozen consumer lock ${lockedWrangler ?? 'unreadable'}`)
const productionConfig = readFileSync(resolve(consumerRoot, 'wrangler.toml'), 'utf8')
const compatibilityDate = productionConfig.match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1]
const flags = productionConfig.match(/^compatibility_flags\s*=\s*\[([\s\S]*?)\]/m)?.[1]
assert(compatibilityDate && flags, 'Consumer Wrangler config must name its compatibility date and flags')
const compatibilityFlags = [...flags.matchAll(/"([^"]+)"/g)].map(match => match[1]!)
// The older receiver for the park refusal control is bound explicitly: AGENT_APP_STOP_OLDER_RECEIVER names the exact
// published package@version, installed in the older consumer and pinned (with integrity) by its frozen lock.
// The older consumer defaults to the runtime consumer; it never changes the executing Wrangler graph.
const olderReceiver = process.env.AGENT_APP_STOP_OLDER_RECEIVER?.match(/^(@tangle-network\/agent-app)@(\d+\.\d+\.\d+)$/)
assert(olderReceiver, 'Set AGENT_APP_STOP_OLDER_RECEIVER=@tangle-network/agent-app@<published version without park>')
const olderConsumerRoot = resolve(process.env.AGENT_APP_STOP_OLDER_CONSUMER_ROOT ?? consumerRoot)
const olderConsumerLock = readFileSync(resolve(olderConsumerRoot, 'pnpm-lock.yaml'))
const publishedAppRoot = resolve(olderConsumerRoot, 'node_modules/@tangle-network/agent-app')
const publishedVersion = (JSON.parse(readFileSync(resolve(publishedAppRoot, 'package.json'), 'utf8')) as { version: string }).version
assert.equal(publishedVersion, olderReceiver[2], 'The installed older receiver must be the bound version')
const olderIntegrity = olderConsumerLock.toString().match(new RegExp(`^  '@tangle-network/agent-app@${publishedVersion.replaceAll('.', '\\.')}':\n    resolution: \\{integrity: (sha512-[^}]+)\\}`, 'm'))?.[1]
assert(olderIntegrity, "The consumer's frozen lock must pin the bound older receiver with its integrity")
const publishedExport = (JSON.parse(readFileSync(resolve(publishedAppRoot, 'package.json'), 'utf8')) as {
  exports: Record<string, { import?: string | { default?: string }; default?: string }> }).exports['./turn-stream']
const publishedImport = typeof publishedExport?.import === 'string' ? publishedExport.import : publishedExport?.import?.default ?? publishedExport?.default
assert(publishedImport, "The consumer's published agent-app must export ./turn-stream")
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
// Candidate imports resolve from their own checkout, not the toolchain consumer's SDK cohort.
const candidateRoot = fileURLToPath(new URL('../../', import.meta.url))
const candidateLock = readFileSync(resolve(candidateRoot, 'pnpm-lock.yaml'))
const candidateRuntime = transportOnly ? undefined : (() => {
  const candidateModules = createRequire(resolve(candidateRoot, 'package.json'))
  const root = dirname(realpathSync(resolve(candidateRoot, 'node_modules/@tangle-network/agent-runtime/package.json')))
  const version = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }).version
  const lockedRuntime = candidateLock.toString().match(/^ {6}'?@tangle-network\/agent-runtime'?:\n {8}specifier:[^\n]*\n {8}version: ([^\s(]+)/m)?.[1]
  assert.equal(version, lockedRuntime, 'Candidate Runtime must match its own frozen lock')
  const entries = Object.fromEntries(['durable', 'tool-loop', 'placement'].map(subpath => {
    const entry = realpathSync(candidateModules.resolve('@tangle-network/agent-runtime/' + subpath))
    assert(entry.startsWith(root + '/'), 'Runtime resolution must stay in the candidate package')
    return [subpath, entry]
  }))
  return { version, root, entries }
})()
const directory = mkdtempSync(resolve(tmpdir(), 'agent-app-durable-stop-'))
const bundleDirectory = resolve(directory, 'bundle')
const workerEntry = transportOnly ? 'durable-stop.transport' : 'durable-stop.worker'
const bundlePath = resolve(bundleDirectory, `${workerEntry}.js`)
const bundleMetafilePath = resolve(directory, 'bundle-meta.json')
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
    releases: 0, releaseSignalAborted: undefined as boolean | undefined, complete: false, providerFailure: false,
    failureObserved: deferred<ServerResponse>(), failureClaimed: false }
}
let active = modelCase()
let nativeProbes = 0
let modelRequests = 0
let hostIntents = 0
const hostAdmissions = new Map<string, { entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<number>> }>()
const hostDisposals = new Map<string, { entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> }>()
const hostControlLosses = new Map<string, { entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>>; revoked: ReturnType<typeof deferred<void>> }>()
const hostBoundaries = new Map<string, { entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>>; arrivals: number; required: number }>()
const PREPARATION_REFUSAL = { code: 'preparation_refused', error: 'The preparation service refused this request.' }
const deferrals = new Map<string, { entered: ReturnType<typeof deferred<void>>; response: ReturnType<typeof deferred<void>>; claimed: boolean }>()
const peer = createServer((request, response) => {
  const path = new URL(request.url!, 'http://localhost').pathname
  let body = ''
  request.setEncoding('utf8').on('data', chunk => { body += chunk }).on('end', () => {
    if (path === '/host-prepare' || path === '/host-history' || path === '/host-acquire' || path === '/host-address' || path === '/host-lock-refusal') {
      const thread = new URL(request.url!, 'http://localhost').searchParams.get('thread')!
      const barrier = hostBoundaries.get(thread)
      assert(barrier, 'The held execution boundary must be bound before the request')
      if (++barrier.arrivals >= barrier.required) barrier.entered.resolve()
      void barrier.release.promise.then(() => {
        if (thread === 'host-prepare-failure' || thread === 'host-prepare-return') {
          response.writeHead(422, { 'content-type': 'application/json' })
          response.end(JSON.stringify(PREPARATION_REFUSAL))
        } else response.end('continue execution boundary')
      }); return
    }
    if (path === '/host-failure-observed') {
      if (active.failureClaimed) { response.end('already observed'); return }
      active.failureClaimed = true; active.failureObserved.resolve(response); return
    }
    if (path === '/host-control-loss' || path === '/host-control-revoked') {
      const barrier = hostControlLosses.get(new URL(request.url!, 'http://localhost').searchParams.get('client')!)
      assert(barrier, 'The control-loss case must be bound before any request')
      if (path === '/host-control-revoked') { barrier.revoked.resolve(); response.end('revoked'); return }
      barrier.entered.resolve(); void barrier.release.promise.then(() => response.end('close control')); return
    }
    if (path === '/host-admission') {
      const barrier = hostAdmissions.get(new URL(request.url!, 'http://localhost').searchParams.get('client')!)
      if (!barrier) { response.end('admitted'); return }
      barrier.entered.resolve()
      void barrier.release.promise.then(status => { response.writeHead(status); response.end('admission result') })
      return
    }
    if (path === '/host-disposal') {
      const barrier = hostDisposals.get(new URL(request.url!, 'http://localhost').searchParams.get('thread')!)
      if (!barrier) { response.end('disposed'); return }
      barrier.entered.resolve(); void barrier.release.promise.then(() => response.end('disposed')); return
    }
    if (path === '/host-intent') { hostIntents++; response.end('intent'); return }
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
    modelRequests++
    const current = active
    if (current.providerFailure) {
      current.entered.resolve()
      response.writeHead(402, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'budget_exceeded', message: 'The provider refused this request.' } }))
      return
    }
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
  return new Miniflare(convertV4MiniflareOptions({ cf: resolve(directory, 'cf.json'), resourcePersistencePath: resolve(directory, 'state'),
    workers: [{ name: 'stop-fixture', modules: true, compatibilityDate,
      compatibilityFlags, scriptPath: bundlePath, modulesRoot: bundleDirectory,
      durableObjects: Object.fromEntries([['TURNS', 'FixtureTurnStream'], ['SHORT_TURNS', 'ShortTurnStream'],
        ['OUTAGE_TURNS', 'ControlOutageTurnStream'], ['DEFERRED_TURNS', 'DeferredTurnStream'], ['SHORT_DEFERRED_TURNS', 'ShortDeferredTurnStream'],
        ['BARRIER_TURNS', 'BarrierTurnStream'], ['PUBLISHED_TURNS', 'PublishedTurnStream'],
        ...(!transportOnly ? [['HOST_TURNS', 'HostedTurnStream']] : [])]
        .map(([binding, className]) => [binding, { className, useSQLite: true }])),
      d1Databases: { CHAT: 'chat' }, bindings: { MODEL_URL: modelUrl, TURN_STREAM_AUTH_SECRET: 'isolated-local-durable-stop-fixture-secret' },
    }] }))
}
let runtime: Runtime | undefined
const identity = (name: string): TurnCancellationIdentity => ({ workspaceId: 'workspace', threadId: name, scope: 'thread',
  executionId: `execution-${name}`, lockId: `lock-${name}`, turnStreamId: `stream-${name}` })
async function request(path: string, input: unknown, authorized: boolean | string = true, earlyControl = true) {
  const abort = new AbortController()
  const operation = (async () => {
    if (!runtime) throw new Error('The fixture runtime has not started')
    const response = await runtime.dispatchFetch(`http://fixture.test${path}`, { method: 'POST', signal: abort.signal, headers: {
      'content-type': 'application/json', ...(authorized ? (path.startsWith('/host-')
        ? { Cookie: `fixture_session=${typeof authorized === 'string' ? authorized : 'fixture-authorized-member'}` }
        : { Authorization: `Bearer ${typeof authorized === 'string' ? authorized : 'fixture-authorized-member'}` }) : {}),
      ...((path === '/host-turn' || path === '/host-loss') && earlyControl ? { [TURN_HOST_CONTROL_HEADER]: TURN_HOST_CONTROL_FIRST } : {}),
    }, body: JSON.stringify(input) })
    // The turn intentionally streams until Stop; every other protocol response
    // must finish its body inside the same bound as its request headers.
    if (path === '/turn' || path === '/host-turn') return response
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
    compatibility_date: compatibilityDate, compatibility_flags: compatibilityFlags, send_metrics: false,
    alias: { 'agent-app-published-turn-stream': resolve(publishedAppRoot, publishedImport) } }))
  execFileSync(process.execPath, [consumer.resolve('wrangler'), 'deploy', '--dry-run',
    '--config', configPath, '--outdir', bundleDirectory, '--metafile', bundleMetafilePath], { cwd: directory,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, timeout: 60_000, encoding: 'utf8', stdio: 'pipe' })
  const bundleMeta = JSON.parse(readFileSync(bundleMetafilePath, 'utf8')) as {
    inputs: Record<string, unknown>; outputs: Record<string, { inputs?: Record<string, { bytesInOutput: number }> }>
  }
  const runtimeBundleInputs = candidateRuntime ? Object.keys(bundleMeta.inputs)
    .filter(input => input.includes('/agent-runtime/') || input.includes('+agent-runtime@'))
    .map(input => ({ input, bytesInOutput: Object.values(bundleMeta.outputs)
      .reduce((total, output) => total + (output.inputs?.[input]?.bytesInOutput ?? 0), 0) })) : []
  const runtimeProvenance = candidateRuntime
    ? { ...candidateRuntime, bundleInputs: runtimeBundleInputs }
    : { status: 'not-applicable', inspected: false, reason: 'Transport-only does not qualify candidate Runtime' }
  console.log(JSON.stringify({ event: 'durable_stop_build_provenance', candidateRuntime: runtimeProvenance,
    bundleMetafileSha256: createHash('sha256').update(readFileSync(bundleMetafilePath)).digest('hex') }))
  if (candidateRuntime) {
    assert(runtimeBundleInputs.some(input => input.bytesInOutput > 0), 'Complete route bundle must include actual Runtime bytes')
    assert(runtimeBundleInputs.every(({ input }) => input.includes('+agent-runtime@' + candidateRuntime.version + '_')
      || input.includes('+agent-runtime@' + candidateRuntime.version + '/')
      || input.startsWith(candidateRuntime.root + '/')), 'Bundle Runtime inputs must match the candidate resolved version; inspect other layouts rather than infer a cohort')
  }
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
  await database.exec("INSERT INTO members VALUES ('second-editor','another-user','workspace','editor');\nINSERT INTO threads VALUES ('host-stop','workspace'),('host-other','workspace'),('host-loss','workspace'),('host-control-loss','workspace'),('host-denied','workspace');\nCREATE TABLE host_steps(thread_id TEXT, kind TEXT);\nCREATE TABLE host_faults(receipt TEXT);")
  await database.exec("INSERT INTO threads VALUES ('host-prepare-stop','workspace'),('host-history-stop','workspace'),('host-prepare-failure','workspace'),('host-acquire-stop-release','workspace'),('host-acquire-stop-successor','workspace'),('host-active-stop','workspace'),('host-active-control-loss','workspace'),('host-provider-failure','workspace');\nCREATE TABLE host_terminal_errors(turn_id TEXT, code TEXT, detail TEXT);\nCREATE TABLE host_failure_checkpoints(thread_id TEXT PRIMARY KEY, detail TEXT);")
  await database.exec("INSERT INTO threads VALUES ('host-prepare-return','workspace'),('host-address-refusal','workspace'),('host-lock-refusal','workspace');\nCREATE TABLE host_refusals(thread_id TEXT PRIMARY KEY, detail TEXT);")
  const replay = identity('replay')
  await acquire(replay)
  assert.deepEqual(await json('/stop', replay), { requested: true })
  assert((await peek(replay))?.cancellation?.requestedAt, 'Durable cancellation intent must persist before acknowledgement')
  // Restart the actual storage process: no isolate memory can carry this request into the next owner connection.
  await runtime.dispose(); runtime = start()
  database = await runtime.getD1Database('CHAT', 'stop-fixture')
  const restored = await peek(replay)
  assert.deepEqual(restored && { workspaceId: restored.workspaceId, threadId: restored.threadId, scope: restored.scope,
    executionId: restored.executionId, lockId: restored.lockId, turnStreamId: restored.cancellation?.turnStreamId }, replay,
    'Runtime restart must retain the exact durable cancellation owner')
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

    // Park records the exact release intent without freeing the lock; only the DO's own completion frees it.
    const parked = identity('parked')
    const parkedSuccessor = { ...parked, executionId: 'execution-parked-successor', lockId: 'lock-parked-successor', turnStreamId: 'stream-parked-successor' }
    await acquire(parked)
    for (const wrong of [{ ...parked, lockId: 'not-the-owner' }, { ...parked, executionId: 'not-the-owner' }]) {
      assert.deepEqual(await json('/park', wrong), { parked: false }, 'A wrong lock or execution identity parks nothing')
    }
    assert.equal((await json<{ active: DurableTurnLock }>('/raw-lock', parked)).active.releasePending, undefined)
    assert.deepEqual(await json('/park', parked), { parked: true })
    const parkedLock = (await json<{ active: DurableTurnLock }>('/raw-lock', parked)).active
    assert.equal(parkedLock.lockId, parked.lockId)
    assert.equal(parkedLock.releasePending, true)
    assert.equal((await json<{ acquired: boolean }>('/lock', parkedSuccessor)).acquired, false, 'A parked lock still refuses a successor')
    assert.deepEqual(await json('/complete-deferred', { ...parked, executionId: 'not-the-owner' }), { completed: false })
    assert.equal((await peek(parked))?.lockId, parked.lockId, 'Another execution cannot complete the parked release')
    assert.deepEqual(await json('/complete-deferred', parked), { completed: true })
    assert.equal(await peek(parked), null)
    await acquire(parkedSuccessor)
    assert.deepEqual(await json('/release', parkedSuccessor), { released: true })
    checks.push('park leaves the exact lock held with releasePending; wrong identity parks or completes nothing; the successor waits for the same execution')

    // The route parks an unconfirmed end only through a lock that has park; a custom lock without park stays held as before.
    const customHeld = identity('custom-held')
    await acquire(customHeld)
    assert.deepEqual(await json('/route-unconfirmed?custom=1', customHeld), { ended: true })
    const customLock = (await json<{ active: DurableTurnLock }>('/raw-lock', customHeld)).active
    assert.equal(customLock.lockId, customHeld.lockId)
    assert.equal(customLock.releasePending, undefined)
    assert.deepEqual(await json('/complete-deferred', customHeld), { completed: false }, 'A lock without park leaves nothing to complete')
    assert.equal((await json<{ acquired: boolean }>('/lock', { ...customHeld, executionId: 'execution-custom-successor',
      lockId: 'lock-custom-successor', turnStreamId: 'stream-custom-successor' })).acquired, false)
    assert.deepEqual(await json('/release', customHeld), { released: true })
    const routeParked = identity('route-parked')
    await acquire(routeParked)
    assert.deepEqual(await json('/route-unconfirmed', routeParked), { ended: true })
    assert.equal((await json<{ active: DurableTurnLock }>('/raw-lock', routeParked)).active.releasePending, true)
    assert.deepEqual(await json('/complete-deferred', routeParked), { completed: true })
    assert.equal(await peek(routeParked), null)
    checks.push('the route parks an unconfirmed end only through a lock with park; a custom lock without park stays held with nothing to complete')

    // An actual published DO from before park has no /chat-turn-lock/park: the intent is refused and the lock stays held.
    assert.equal('lockPark' in (await json<{ paths: Record<string, string> }>('/published-paths', parked)).paths, false,
      "The consumer's published agent-app must predate park for this control")
    const older = identity('older-receiver')
    await acquire(older, '?published=1')
    const refused = await json<{ parked: boolean; refused?: string }>('/park?published=1', older)
    assert.equal(refused.parked, false)
    assert(refused.refused, 'An older receiver refuses the park request')
    const olderLock = await peek(older, '?published=1')
    assert.equal(olderLock?.lockId, older.lockId)
    assert.equal(olderLock?.releasePending, undefined)
    assert.deepEqual(await json('/release?published=1', older), { released: true })
    checks.push(`the published pre-park DO ${olderReceiver[0]} (${olderIntegrity}) refuses park over public HTTP and keeps the lock held`)

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
      assert.equal(response.status, 200, response.status === 200 ? 'Product turn should succeed'
        : `Product turn ${mode} refused (HTTP ${response.status}): ${await bounded(response.text(), 'failed product response body')}`)
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
      } else if (mode === 'transport-loss') {
        // A dropped socket alone is reopened; the turn ends when its reconnects are refused too.
        await json('/close?lost=1', owner)
      } else if (mode === 'external-release') {
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

    const hostRead = (path: string) => bounded(runtime!.dispatchFetch(`http://fixture.test${path}`, {
      headers: { Cookie: 'fixture_session=fixture-authorized-member' },
    }), path)
    const admission = (client: string) => {
      const barrier = { entered: deferred<void>(), release: deferred<number>() }
      hostAdmissions.set(client, barrier)
      return barrier
    }
    const watchHost = (response: Response) => {
      const receipt = deferred<TurnHostControlTarget>()
      const phases: string[] = []
      const settled = settleTurnResponse(response, phase => phases.push(phase.phase), undefined, target => receipt.resolve(target))
      void settled.catch(() => {})
      return { receipt, phases, settled }
    }
    const staleHost = (target: TurnHostControlTarget) => bounded((async () => {
      for (;;) {
        const result = await json<{ requested: boolean }>('/host-cancel', target)
        if (!result.requested) return
        await delay(10)
      }
    })(), 'host finishes all tracked work')
    const hostPeek = (threadId: string) => peek({ ...identity(threadId), scope: 'workspace' })

    // Real cookie/editor/thread access, host DO, SQLite and entitlement HTTP barrier.
    const modelsBeforeStop = modelRequests
    const intentsBeforeStop = hostIntents
    const stoppedAdmission = admission('host-client')
    const stopped = watchHost(await request('/host-turn', { threadId: 'host-stop', turnId: 'host-client', content: 'Read this request.' }))
    const stoppedTarget = await bounded(stopped.receipt.promise, 'control identity before paid admission')
    await bounded(stoppedAdmission.entered.promise, 'paid authorization remains blocked')
    assert.equal(await hostPeek('host-stop'), null)
    assert.deepEqual(stopped.phases, [], 'A control receipt is not accepted/admitted progress')
    for (const actor of [false, 'viewer-member', 'foreign-editor'] as const) {
      assert.equal((await request('/host-cancel', stoppedTarget, actor)).status, actor === false ? 401 : 403)
    }
    assert.equal((await request('/host-cancel', { ...stoppedTarget, workspaceId: 'other-workspace' })).status, 403)
    assert.deepEqual(await json('/host-cancel', { ...stoppedTarget, threadId: 'host-other' }), { requested: false, reason: 'stale-host' })
    assert.deepEqual(await json('/host-cancel', { ...stoppedTarget, clientTurnId: 'wrong-client' }), { requested: false, reason: 'stale-host' })
    assert.deepEqual(await json('/host-cancel', { ...stoppedTarget, retryAttemptId: 'wrong-retry' }), { requested: false, reason: 'stale-host' })
    assert.deepEqual(await json('/host-unknown', stoppedTarget), { requested: false, reason: 'stale-host' })
    assert.equal((await request('/host-repeat', stoppedTarget)).status, 409, 'A repeated start cannot replace the live controller')
    const hostStopOtherOwner = { ...identity('host-other'), scope: 'workspace' as const }
    await acquire(hostStopOtherOwner)
    // An editor other than the sender may Stop the captured workspace invocation.
    const otherEditorStop = await request('/host-cancel', stoppedTarget, 'second-editor')
    assert.equal(otherEditorStop.status, 200)
    assert.deepEqual(await otherEditorStop.json(), { requested: true })
    assert.deepEqual(await json('/host-cancel', stoppedTarget), { requested: true })
    assert.equal((await hostPeek('host-stop'))?.lockId, hostStopOtherOwner.lockId)
    stoppedAdmission.release.resolve(200)
    const stoppedResult = await bounded(stopped.settled, 'stopped admission response')
    assert.equal(stoppedResult.status, 409)
    assert.equal((await stoppedResult.json() as { code: string }).code, 'turn_cancel_requested')
    assert.equal(modelRequests, modelsBeforeStop)
    assert.equal(hostIntents, intentsBeforeStop)
    assert.equal((await database.prepare('SELECT * FROM messages WHERE thread_id = ?').bind('host-stop').all()).results.length, 0)
    assert.equal((await database.prepare('SELECT * FROM host_steps WHERE thread_id = ?').bind('host-stop').all()).results.length, 0,
      'Stop precedes afterAuthorize and resource acquisition')
    assert.deepEqual(await (await hostRead('/host-running?threadId=host-stop')).json(), { running: [] })
    assert.equal((await hostPeek('host-stop'))?.lockId, hostStopOtherOwner.lockId, 'Stopped admission neither acquires nor releases the other owner')
    await json('/release', hostStopOtherOwner)
    assert.equal(await hostPeek('host-stop'), null)
    await staleHost(stoppedTarget)
    checks.push('host: cookie editor Stop before paid admission gates all target work; exact other-thread owner survives')

    // Ordinary view loss does not set Stop. The same C is a new H, not a tombstone replay.
    const modelsBeforeNormal = modelRequests
    active = modelCase(); active.complete = true
    const normalAdmission = admission('host-client')
    const disposal = { entered: deferred<void>(), release: deferred<void>() }
    hostDisposals.set('host-stop', disposal)
    const normalResponse = await request('/host-turn', { threadId: 'host-stop', turnId: 'host-client', retryAttemptId: 'retry-2', content: 'Read my new request.' })
    const reader = normalResponse.body!.getReader()
    let prefix = ''
    while (!prefix.includes('\n')) prefix += new TextDecoder().decode((await bounded(reader.read(), 'early host event')).value)
    const controlEvent: unknown = JSON.parse(prefix.slice(0, prefix.indexOf('\n')))
    assert(isTurnHostControlEvent(controlEvent))
    const normalTarget = controlEvent.data
    assert.notEqual(normalTarget.hostId, stoppedTarget.hostId)
    await bounded(normalAdmission.entered.promise, 'successor delayed entitlement')
    assert.deepEqual(await json('/host-cancel', stoppedTarget), { requested: false, reason: 'stale-host' })
    assert.deepEqual(await json('/host-cancel', { ...normalTarget, retryAttemptId: undefined }), { requested: false, reason: 'stale-host' })
    await bounded(reader.cancel(), 'ordinary tab disconnect')
    normalAdmission.release.resolve(200)
    await bounded(active.entered.promise, 'detached hosted model HTTP')
    await bounded(active.admitted.promise, 'detached hosted workspace owner')
    const normalOwner = (await hostPeek('host-stop'))!
    assert(normalOwner?.cancellation)
    assert.equal(normalOwner.cancellation.requestedAt, undefined)
    const oldExact = { ...hostStopOtherOwner, turnStreamId: hostStopOtherOwner.turnStreamId }
    assert.deepEqual(await json('/stop', oldExact), { requested: false, reason: 'stale-owner' }, 'Old exact stream control cannot Stop the new workspace generation')
    const normalSettlement = await bounded(active.settling.promise, 'detached terminal lifecycle')
    normalSettlement.end('settled')
    await bounded(active.released.promise, 'detached exact lock release')
    await bounded(disposal.entered.promise, 'resource disposal after response/drain')
    assert.equal(await hostPeek('host-stop'), null)
    const saved = await database.prepare('SELECT content FROM messages WHERE thread_id = ? AND role = ?').bind('host-stop', 'assistant').all<{ content: string }>()
    assert.equal(saved.results.length, 1)
    assert.equal(saved.results[0]!.content, 'The request is complete.')
    assert.equal(modelRequests, modelsBeforeNormal + 1, 'Ordinary disconnect starts exactly one producer')
    assert.equal(active.releases, 1, 'The exact hosted owner releases once')
    const replayResponse = await hostRead(`/host-replay?turnId=${normalOwner.cancellation.turnStreamId}`)
    assert.equal(replayResponse.status, 200)
    assert((await bounded(replayResponse.text(), 'saved hosted replay')).includes('The request is complete.'))
    assert.deepEqual(await json('/host-cancel', normalTarget), { requested: true }, 'Control lifetime includes held resource disposal')
    disposal.release.resolve()
    await staleHost(normalTarget)
    assert.equal((await request('/host-repeat', normalTarget)).status, 409)
    checks.push('host: ordinary disconnect saves/replays once; old H/attempt/stream are fenced; control survives resource disposal')

    // Pause an attached view after the shared parser receives H, not after an assumed first chunk.
    const slowViewThread = 'host-slow-view'
    await database.prepare('INSERT INTO threads VALUES (?, ?)').bind(slowViewThread, 'workspace').all()
    const slowViewModelsBefore = modelRequests
    const slowViewModel = modelCase()
    slowViewModel.complete = true
    active = slowViewModel
    const slowViewAdmission = admission('slow-view-client')
    const slowViewDisposal = { entered: deferred<void>(), release: deferred<void>() }
    hostDisposals.set(slowViewThread, slowViewDisposal)
    const slowViewReceipt = deferred<TurnHostControlTarget>()
    const slowViewPauseEntered = deferred<void>()
    const slowViewResume = deferred<void>()
    let slowViewPaused = false
    try {
      const slowViewResponse = await request('/host-turn', { threadId: slowViewThread, turnId: 'slow-view-client', content: 'Finish while this view waits.' })
      const slowViewSource = slowViewResponse.body!.getReader()
      const slowViewBytes = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (slowViewPaused) {
            slowViewPauseEntered.resolve()
            await slowViewResume.promise
          }
          const next = await slowViewSource.read()
          if (next.done) controller.close()
          else controller.enqueue(next.value)
        },
        cancel(reason) { slowViewResume.resolve(); return slowViewSource.cancel(reason) },
      }, { highWaterMark: 0 })
      const slowViewSettled = settleTurnResponse(new Response(slowViewBytes, {
        status: slowViewResponse.status, headers: slowViewResponse.headers,
      }), () => {}, undefined, target => {
        slowViewPaused = true
        slowViewReceipt.resolve(target)
      })
      void slowViewSettled.catch(() => {})
      const slowViewTarget = await bounded(slowViewReceipt.promise, 'slow attached view receives actual shared control receipt')
      await bounded(slowViewPauseEntered.promise, 'slow attached view is paused before its next underlying read')
      await bounded(slowViewAdmission.entered.promise, 'slow-view paid admission remains held')
      slowViewAdmission.release.resolve(200)
      await bounded(slowViewModel.entered.promise, 'slow-view real model HTTP')
      await bounded(slowViewModel.admitted.promise, 'slow-view exact workspace owner')
      const slowViewOwner = (await hostPeek(slowViewThread))!
      assert(slowViewOwner?.cancellation)
      const slowViewSettlement = await bounded(slowViewModel.settling.promise, 'slow-view terminal lifecycle')
      slowViewSettlement.end('settled')
      await bounded(slowViewModel.released.promise, 'slow-view exact lock release')
      await bounded(slowViewDisposal.entered.promise, 'slow-view resource disposal entered')
      slowViewDisposal.release.resolve()
      await bounded((async () => {
        for (;;) {
          const disposedRows = await database.prepare('SELECT kind FROM host_steps WHERE thread_id = ? AND kind = ?')
            .bind(slowViewThread, 'disposed').all()
          if (disposedRows.results.length) {
            assert.equal(disposedRows.results.length, 1)
            return
          }
          await delay(10)
        }
      })(), 'slow-view resource disposal completed')
      await staleHost(slowViewTarget)
      assert.equal(slowViewPaused, true, 'H retires while the attached view is still paused')
      assert.equal(await hostPeek(slowViewThread), null)
      assert.equal(slowViewModel.releases, 1)
      assert.equal(modelRequests, slowViewModelsBefore + 1, 'A paused view starts exactly one producer')
      const slowViewEffects = await database.prepare('SELECT code FROM effects WHERE turn_id = ?')
        .bind(slowViewOwner.cancellation.turnStreamId).all<{ code: string }>()
      assert.deepEqual(slowViewEffects.results.map(row => row.code), ['complete'])
      const slowViewSaved = await database.prepare('SELECT role, content FROM messages WHERE thread_id = ? ORDER BY rowid')
        .bind(slowViewThread).all<{ role: string; content: string }>()
      assert.deepEqual(slowViewSaved.results.map(row => row.role), ['user', 'assistant'])
      assert.equal(slowViewSaved.results[1]!.content, 'The request is complete.')
      slowViewPaused = false
      slowViewResume.resolve()
      const slowViewResult = await bounded(slowViewSettled, 'resume the same shared response parser')
      const slowViewBody = await bounded(slowViewResult.text(), 'read the complete queued slow-view body')
      assert.equal(slowViewResult.status, 200)
      assert.equal(slowViewBody.split('The request is complete.').length - 1, 1, 'Queued answer is neither lost nor duplicated')
      assert.equal(slowViewBody.split('"type":"session.run.completed"').length - 1, 1)
      assert(!slowViewBody.includes('"type":"session.run.failed"'))
      assert(slowViewBody.endsWith('\n'), 'The real queued body reaches its complete final frame')
      const slowViewReplay = await hostRead(`/host-replay?turnId=${slowViewOwner.cancellation.turnStreamId}`)
      assert.equal(slowViewReplay.status, 200)
      const slowViewReplayBody = await bounded(slowViewReplay.text(), 'slow-view saved replay')
      assert.equal(slowViewReplayBody.split('The request is complete.').length - 1, 1)
      assert.equal(modelRequests, slowViewModelsBefore + 1, 'Resuming the same view cannot start another producer')
      assert.equal(slowViewModel.releases, 1)
      checks.push('host: a paused attached shared-parser view retains every answer byte after model, lock, resource and H settle once')
    } finally {
      slowViewAdmission.release.resolve(200)
      slowViewDisposal.release.resolve()
      slowViewPaused = false
      slowViewResume.resolve()
    }

    const modelsBeforeLoss = modelRequests
    const intentsBeforeLoss = hostIntents
    const lossAdmission = admission('loss-client')
    const loss = await request('/host-loss', { threadId: 'host-loss', turnId: 'loss-client', content: 'Must not fall back.' })
    assert.equal(loss.status, 503)
    assert.equal((await loss.json() as { code: string }).code, 'turn_control_unavailable')
    const fault = await database.prepare('SELECT receipt FROM host_faults').all<{ receipt: string }>()
    assert.equal(fault.results.length, 1)
    const lossReceipt = JSON.parse(fault.results[0]!.receipt) as { target: TurnHostControlTarget; stop: { requested: boolean } }
    assert.equal(lossReceipt.stop.requested, true, 'Fault follows an actual accepted host Stop')
    await bounded(lossAdmission.entered.promise, 'original host is still awaiting paid admission')
    lossAdmission.release.resolve(200)
    await staleHost(lossReceipt.target)
    assert.equal(modelRequests, modelsBeforeLoss)
    assert.equal(hostIntents, intentsBeforeLoss)
    assert.equal((await database.prepare('SELECT * FROM messages WHERE thread_id = ?').bind('host-loss').all()).results.length, 0)
    assert.equal(await hostPeek('host-loss'), null)
    checks.push('host: injected outer transport loss after accepted Stop cannot fall back to local execution')

    const controlLoss = { entered: deferred<void>(), release: deferred<void>(), revoked: deferred<void>() }
    hostControlLosses.set('control-loss-client', controlLoss)
    const controlLossAdmission = admission('control-loss-client')
    const beforeControlLoss = { models: modelRequests, intents: hostIntents }
    const lost = watchHost(await request('/host-turn', { threadId: 'host-control-loss', turnId: 'control-loss-client', content: 'Control must fence this request.' }))
    await bounded(lost.receipt.promise, 'live host control established')
    await bounded(controlLossAdmission.entered.promise, 'control loss while paid admission is blocked')
    await bounded(controlLoss.entered.promise, 'actual host-owned socket is ready to close')
    controlLoss.release.resolve()
    // Positive observation from the original invocation's abort signal, not a sleep.
    await bounded(controlLoss.revoked.promise, 'original execution permission revoked on actual socket close')
    controlLossAdmission.release.resolve(200)
    const lostResult = await bounded(lost.settled, 'lost-control admission refusal')
    assert.equal(lostResult.status, 503)
    assert.equal((await lostResult.json() as { code: string }).code, 'turn_control_unavailable')
    assert.equal(modelRequests, beforeControlLoss.models)
    assert.equal(hostIntents, beforeControlLoss.intents)
    assert.equal((await database.prepare('SELECT * FROM messages WHERE thread_id = ?').bind('host-control-loss').all()).results.length, 0)
    assert.equal(await hostPeek('host-control-loss'), null)
    checks.push('host: actual control-socket loss revokes the old invocation before paid admission resumes')

    // Stop while post-paid work is suspended must gate later execution effects.
    for (const stage of ['prepare', 'history', 'prepare-failure', 'prepare-return'] as const) {
      const refusal = stage === 'prepare-failure' || stage === 'prepare-return'
      const thread = refusal ? `host-${stage}` : `host-${stage}-stop`
      const barrier = { entered: deferred<void>(), release: deferred<void>(), arrivals: 0, required: stage === 'history' ? 2 : 1 }
      hostBoundaries.set(thread, barrier)
      const modelsBefore = modelRequests
      const pending = watchHost(await request('/host-turn', { threadId: thread, turnId: `client-${thread}`, content: 'Stop during preparation.' }))
      const target = await bounded(pending.receipt.promise, 'held post-paid host identity')
      await bounded(barrier.entered.promise, 'actual post-paid preparation/history HTTP boundary')
      // Intent generation/reads and resource acquisition may already have begun.
      // This assertion concerns new producer/lock/user effects after the held gate.
      assert.equal(modelRequests, modelsBefore)
      const other = { ...identity('host-other'), scope: 'workspace' as const, executionId: `other-${stage}`, lockId: `other-${stage}` }
      await acquire(other)
      assert.deepEqual(await json('/host-cancel', target), { requested: true })
      barrier.release.resolve()
      const result = await bounded(pending.settled, 'post-preparation Stop response')
      assert.equal(result.status, refusal ? 422 : 409)
      const body = await result.json() as { code: string }
      if (refusal) assert.deepEqual(body, PREPARATION_REFUSAL)
      else assert.equal(body.code, 'turn_cancel_requested')
      await staleHost(target)
      const steps = await database.prepare('SELECT kind FROM host_steps WHERE thread_id = ? ORDER BY rowid').bind(thread).all<{ kind: string }>()
      assert.deepEqual(steps.results.map(row => row.kind), ['early', 'disposed'])
      assert.equal(modelRequests, modelsBefore)
      assert.equal((await database.prepare('SELECT * FROM messages WHERE thread_id = ?').bind(thread).all()).results.length, 0)
      assert.deepEqual(await (await hostRead(`/host-running?threadId=${thread}`)).json(), { running: [] })
      assert.equal((await hostPeek(thread))?.lockId, other.lockId, 'No target acquire/release touches the other generation')
      await json('/release', other)
      checks.push(`host: Stop during held ${stage} prevents later model/lock/user work and disposes owned resources`)
    }

    const addressThread = 'host-address-refusal'
    const addressBarrier = { entered: deferred<void>(), release: deferred<void>(), arrivals: 0, required: 1 }
    hostBoundaries.set(addressThread, addressBarrier)
    const modelsBeforeAddress = modelRequests
    const addressPending = watchHost(await request('/host-turn', { threadId: addressThread, turnId: 'address-client',
      content: '@unavailable Explain this.', mentions: [{ kind: 'agent', agentId: 'missing', handle: 'unavailable', name: 'Unavailable' }] }))
    const addressTarget = await bounded(addressPending.receipt.promise, 'addressing host identity')
    await bounded(addressBarrier.entered.promise, 'real agent resolver held before returning no matching agent')
    assert.deepEqual(await json('/host-cancel', addressTarget), { requested: true })
    addressBarrier.release.resolve()
    const addressResult = await bounded(addressPending.settled, 'returned addressing refusal')
    assert.equal(addressResult.status, 400)
    assert.deepEqual(await addressResult.json(), { code: 'unknown_agent', error: 'Unknown agent @unavailable' })
    await staleHost(addressTarget)
    assert.equal(modelRequests, modelsBeforeAddress)
    assert.equal((await database.prepare('SELECT * FROM messages WHERE thread_id = ?').bind(addressThread).all()).results.length, 0)
    assert.equal((await database.prepare('SELECT * FROM host_steps WHERE thread_id = ? AND kind = ?').bind(addressThread, 'acquire').all()).results.length, 0)
    assert.equal((await database.prepare('SELECT * FROM host_steps WHERE thread_id = ? AND kind = ?').bind(addressThread, 'disposed').all()).results.length, 1)
    checks.push('host: a real returned addressing refusal retains its authority after pending Stop')

    const refusalThread = 'host-lock-refusal'
    const refusalBarrier = { entered: deferred<void>(), release: deferred<void>(), arrivals: 0, required: 1 }
    hostBoundaries.set(refusalThread, refusalBarrier)
    const heldRefusalOwner = { ...identity('host-other'), scope: 'workspace' as const, executionId: 'refusal-owner', lockId: 'refusal-owner' }
    await acquire(heldRefusalOwner)
    active = modelCase()
    const refusalPending = watchHost(await request('/host-turn', { threadId: refusalThread, turnId: 'lock-refusal-client', content: 'A held workspace refuses this turn.' }))
    const refusalTarget = await bounded(refusalPending.receipt.promise, 'lock-refusal host identity')
    await bounded(refusalBarrier.entered.promise, 'real held-lock refusal captured before return')
    await bounded(active.entered.promise, 'dispatch already began before the lock refusal')
    const modelsAtRefusalStop = modelRequests
    const hostLockRefusalRows = await database.prepare('SELECT detail FROM host_refusals WHERE thread_id = ?').bind(refusalThread).all<{ detail: string }>()
    assert.equal(hostLockRefusalRows.results.length, 1)
    const refusalSnapshot = JSON.parse(hostLockRefusalRows.results[0]!.detail) as { status: number; body: string }
    assert.deepEqual(await json('/host-cancel', refusalTarget), { requested: true })
    await bounded(active.aborted.promise, 'Stop closes the already-started refusal-path model call')
    refusalBarrier.release.resolve()
    const refusalResult = await bounded(refusalPending.settled, 'authoritative returned lock refusal')
    assert.equal(refusalResult.status, refusalSnapshot.status)
    assert.equal(await refusalResult.text(), refusalSnapshot.body)
    await staleHost(refusalTarget)
    assert.equal(modelRequests, modelsAtRefusalStop, 'No new dispatch follows the returned refusal')
    assert.equal(active.releases, 0, 'A refused acquire confers no release authority')
    assert.equal((await hostPeek(refusalThread))?.lockId, heldRefusalOwner.lockId)
    assert.equal((await database.prepare('SELECT * FROM messages WHERE thread_id = ?').bind(refusalThread).all()).results.length, 0)
    assert.deepEqual(await (await hostRead(`/host-running?threadId=${refusalThread}`)).json(), { running: [] })
    assert.equal((await database.prepare('SELECT * FROM host_steps WHERE thread_id = ? AND kind = ?').bind(refusalThread, 'disposed').all()).results.length, 1)
    await json('/release', heldRefusalOwner)
    checks.push('host: a genuine held-lock refusal retains its status/body and exact other owner after Stop')

    // An acquire that began before Stop may finish afterwards. Adopt the exact
    // returned handle/connection only to clean them, before any user/running row.
    for (const mode of ['release', 'successor'] as const) {
      const thread = `host-acquire-stop-${mode}`
      const barrier = { entered: deferred<void>(), release: deferred<void>(), arrivals: 0, required: 1 }
      hostBoundaries.set(thread, barrier)
      active = modelCase()
      const pending = watchHost(await request('/host-turn', { threadId: thread, turnId: `client-${thread}`, content: 'Stop during acquire.' }))
      const target = await bounded(pending.receipt.promise, 'acquiring host identity')
      await bounded(barrier.entered.promise, 'actual acquired generation held before returning to route')
      await bounded(active.entered.promise, 'Router call already started before Stop')
      const modelsAtStop = modelRequests
      const lock = (await hostPeek(thread))!
      assert(lock?.cancellation)
      const exact = { ...lock, turnStreamId: lock.cancellation.turnStreamId }
      assert.deepEqual(await json('/host-cancel', target), { requested: true })
      await bounded(active.aborted.promise, 'Stop closes already-started Router HTTP')
      const successor = { ...exact, executionId: 'acquire-successor', lockId: 'acquire-successor', turnStreamId: 'acquire-successor-stream' }
      if (mode === 'successor') { await json('/release', exact); await acquire(successor) }
      barrier.release.resolve()
      const result = await bounded(pending.settled, 'Stop after in-flight acquire')
      assert.equal(result.status, 409)
      assert.equal((await result.json() as { code: string }).code, 'turn_cancel_requested')
      await bounded(active.released.promise, 'exact acquired cleanup attempt')
      await staleHost(target)
      assert.equal(active.releases, 1)
      assert.equal(modelRequests, modelsAtStop, 'No second producer begins after Stop')
      assert.equal((await database.prepare('SELECT * FROM messages WHERE thread_id = ?').bind(thread).all()).results.length, 0)
      assert.deepEqual(await (await hostRead(`/host-running?threadId=${thread}`)).json(), { running: [] })
      assert.equal((await database.prepare('SELECT kind FROM host_steps WHERE thread_id = ? AND kind = ?').bind(thread, 'disposed').all()).results.length, 1)
      if (mode === 'successor') {
        assert.equal((await hostPeek(thread))?.lockId, successor.lockId)
        await json('/release', successor)
      } else assert.equal(await hostPeek(thread), null)
      assert.deepEqual(await json('/sockets', exact), { open: 0 })
      checks.push(`host: Stop racing acquire ${mode} cleans the captured generation without user effects`)
    }

    for (const mode of ['stop', 'control-loss', 'provider-failure'] as const) {
      const thread = mode === 'provider-failure' ? 'host-provider-failure' : `host-active-${mode}`
      const client = `client-${thread}`
      const loss = { entered: deferred<void>(), release: deferred<void>(), revoked: deferred<void>() }
      if (mode === 'control-loss') hostControlLosses.set(client, loss)
      active = modelCase(); active.providerFailure = mode === 'provider-failure'
      const pending = watchHost(await request('/host-turn', { threadId: thread, turnId: client, content: 'Observe the active producer terminal.' }))
      const target = await bounded(pending.receipt.promise, 'active host identity')
      const response = await bounded(pending.settled, 'active turn marker')
      const wire = response.text(); void wire.catch(() => {})
      await bounded(active.entered.promise, 'actual active Router HTTP')
      await bounded(active.admitted.promise, 'actual active workspace owner')
      const lock = (await hostPeek(thread))!
      assert(lock?.cancellation)
      let originalFailure: unknown
      if (mode === 'provider-failure') {
        const checkpoint = await bounded(active.failureObserved.promise, 'real provider failure observed before late Stop')
        const captured = await database.prepare('SELECT detail FROM host_failure_checkpoints WHERE thread_id = ?').bind(thread).all<{ detail: string }>()
        assert.equal(captured.results.length, 1)
        originalFailure = JSON.parse(captured.results[0]!.detail)
        assert.equal(typeof (originalFailure as { code?: unknown }).code, 'string', 'Provider failure supplies richer typed data')
        assert.deepEqual(await json('/host-cancel', target), { requested: true })
        checkpoint.end('failure observed')
      } else if (mode === 'control-loss') {
        await bounded(loss.entered.promise, 'real owner socket held before active loss')
        loss.release.resolve()
        await bounded(loss.revoked.promise, 'active original owner permission revoked')
      } else assert.deepEqual(await json('/host-cancel', target), { requested: true })
      if (mode !== 'provider-failure') await bounded(active.aborted.promise, 'typed cancellation closes active model HTTP')
      const settlement = await bounded(active.settling.promise, 'actual terminal hook held through settlement')
      const terminal = await database.prepare('SELECT code, detail FROM host_terminal_errors WHERE turn_id = ?')
        .bind(lock.cancellation.turnStreamId).all<{ code: string; detail: string }>()
      assert.equal(terminal.results.length, 1, 'Exactly one actual onTurnError observation')
      if (mode === 'provider-failure') assert.deepEqual(JSON.parse(terminal.results[0]!.detail), originalFailure,
        'Late Stop preserves the richer producer failure rather than reclassifying it')
      else assert.equal(terminal.results[0]!.code, mode === 'stop' ? 'turn_cancel_requested' : 'turn_control_unavailable')
      assert.equal((await hostPeek(thread))?.lockId, lock.lockId, 'Terminal hook still owns settlement before exact release')
      settlement.end('settled')
      await bounded(active.released.promise, 'active exact owner settles/releases')
      const visible = await bounded(wire, 'active terminal wire')
      assert(!visible.includes('sk-fixture-private-control-close'), 'Raw WebSocket close reason never reaches chat')
      const replay = await hostRead(`/host-replay?turnId=${lock.cancellation.turnStreamId}`)
      assert(!(await bounded(replay.text(), 'active terminal replay')).includes('sk-fixture-private-control-close'))
      assert.deepEqual(await json('/status', { ...lock, turnStreamId: lock.cancellation.turnStreamId }), { status: 'error' })
      await staleHost(target)
      assert.equal(active.releases, 1)
      assert.equal(await hostPeek(thread), null)
      assert.equal((await database.prepare('SELECT * FROM messages WHERE thread_id = ? AND role = ?').bind(thread, 'assistant').all()).results.length, 0)
      checks.push(`host: active ${mode} retains the actual server error through typed cancellation and exact settlement`)
    }

    for (const early of [false, true]) {
      const client = `denied-${early}`
      const deniedAdmission = admission(client)
      const responsePromise = request('/host-turn', { threadId: 'host-denied', turnId: client, content: 'A refused request.' }, true, early)
      void responsePromise.catch(() => {})
      await bounded(deniedAdmission.entered.promise, 'refused paid admission barrier')
      if (early) {
        const response = await responsePromise
        const denied = watchHost(response)
        await bounded(denied.receipt.promise, 'authorized control before paid refusal')
        assert.deepEqual(denied.phases, [])
        deniedAdmission.release.resolve(402)
        const result = await bounded(denied.settled, 'opt-in paid refusal')
        assert.equal(result.status, 402)
        assert.equal(await result.text(), 'Payment required')
      } else {
        deniedAdmission.release.resolve(402)
        const result = await responsePromise
        assert.equal(result.status, 402)
        assert.equal(result.headers.get(TURN_HOST_CONTROL_HEADER), null)
        assert.equal(await result.text(), 'Payment required')
      }
    }
    for (const actor of [false, 'viewer-member', 'foreign-editor'] as const) {
      const denied = await request('/host-turn', { threadId: 'host-denied', content: 'Must refuse before control.' }, actor)
      assert.equal(denied.status, actor === false ? 401 : 403)
      assert.equal(denied.headers.get(TURN_HOST_CONTROL_HEADER), null)
    }
    assert.equal((await database.prepare('SELECT * FROM messages WHERE thread_id = ?').bind('host-denied').all()).results.length, 0)
    checks.push('host: opt-in paid refusal unwraps correctly; legacy HTTP refusal and denied identity remain unchanged')

    // Exercise the public browser helper, not only the raw hosted-response settlement helper.
    const { streamChatTurn } = await import('../../src/web-react/chat-stream')
    const browserRefusals: Array<{ mode: 'stop' | 'control-loss'; error: Error & { code?: string } }> = []
    for (const mode of ['stop', 'control-loss'] as const) {
      const thread = mode === 'control-loss' ? 'host-control-loss' : 'host-public-stop'
      const client = `public-${mode}`
      if (mode === 'stop') await database.prepare('INSERT INTO threads VALUES (?, ?)').bind(thread, 'workspace').all()
      if (mode === 'control-loss') {
        await staleHost(await lost.receipt.promise)
        assert.equal(await hostPeek(thread), null, 'Prior control-loss owner is retired before reusing its thread')
      }
      const paid = admission(client)
      const received = deferred<TurnHostControlTarget>()
      const socket = { entered: deferred<void>(), release: deferred<void>(), revoked: deferred<void>() }
      if (mode === 'control-loss') hostControlLosses.set(client, socket)
      const before = { models: modelRequests, intents: hostIntents }
      let failure: unknown
      const completed = streamChatTurn({
        start: () => request('/host-turn', { threadId: thread, turnId: client, content: 'Preserve the hosted refusal code.' }),
        callbacks: { onHostControl: target => received.resolve(target) },
        maxReconnects: 0,
      }).catch(error => { failure = error })
      const target = await bounded(received.promise, 'public helper receives synchronous H before paid admission')
      await bounded(paid.entered.promise, 'public helper paid admission barrier')
      if (mode === 'stop') {
        const cancellation = json('/host-cancel', target)
        assert.deepEqual(await bounded(cancellation, 'separately observed exact-H cancellation'), { requested: true })
      } else {
        await bounded(socket.entered.promise, 'public helper actual control socket ready')
        socket.release.resolve()
        await bounded(socket.revoked.promise, 'public helper original execution permission revoked')
      }
      paid.release.resolve(200)
      await bounded(completed, 'public helper rejects the real hosted refusal')
      assert(failure instanceof Error, 'The public helper must reject an actual hosted refusal')
      await staleHost(target)
      assert.equal(await hostPeek(thread), null)
      assert.equal(modelRequests, before.models)
      assert.equal(hostIntents, before.intents)
      assert.equal((await database.prepare('SELECT * FROM messages WHERE thread_id = ?').bind(thread).all()).results.length, 0)
      browserRefusals.push({ mode, error: failure })
      console.log(JSON.stringify({ event: 'public_hosted_refusal', mode,
        expectedCode: mode === 'stop' ? 'turn_cancel_requested' : 'turn_control_unavailable',
        actualCode: (failure as Error & { code?: string }).code ?? null,
        modelCalls: modelRequests - before.models, originalOwnerReleased: true }))
    }
    for (const { mode, error } of browserRefusals) {
      assert.equal(error.code, mode === 'stop' ? 'turn_cancel_requested' : 'turn_control_unavailable',
        `public streamChatTurn preserves the actual hosted ${mode} refusal code`)
      checks.push(`browser: public streamChatTurn preserves the actual hosted ${mode} refusal code`)
    }
  }
  console.log(JSON.stringify({ checks, consumerRoot, scope: transportOnly ? 'transport-only' : 'complete-product-route',
    consumerRevision: execFileSync('git', ['-C', consumerRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    consumerLockSha256: createHash('sha256').update(consumerLock).digest('hex'),
    consumerGraphRole: 'Wrangler/Miniflare/compiler/flags; not the candidate SDK cohort',
    candidateRevision: execFileSync('git', ['-C', candidateRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    candidateLockSha256: createHash('sha256').update(candidateLock).digest('hex'),
    candidateRuntime: runtimeProvenance,
    bundleMetafileSha256: createHash('sha256').update(readFileSync(bundleMetafilePath)).digest('hex'),
    olderConsumerRoot,
    olderConsumerRevision: execFileSync('git', ['-C', olderConsumerRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    olderConsumerLockSha256: createHash('sha256').update(olderConsumerLock).digest('hex'),
    olderReceiver: { package: olderReceiver[0], integrity: olderIntegrity,
      entry: realpathSync(resolve(publishedAppRoot, publishedImport)),
      entrySha256: createHash('sha256').update(readFileSync(resolve(publishedAppRoot, publishedImport))).digest('hex') },
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
