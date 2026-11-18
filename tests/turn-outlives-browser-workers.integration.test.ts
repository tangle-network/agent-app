import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { createTestHarness } from 'wrangler'

/**
 * Real local workerd, D1, the shared chat routes and an authenticated TurnStreamDO subclass
 * (`workers/turn-outlives-browser.worker.ts`). A member's turn answers over 40 s; the browser that sent it disconnects
 * at 2 s. The answer must still be stored, the lock released and the turn replayed in full, and the turn's work must
 * have run under a turn-stream object's `waitUntil`, never the browser request's: Cloudflare cancels a Worker request's
 * `waitUntil` work soon after its client leaves, which local workerd may not do (the probe below measures it). A second
 * turn's host then loses its object after the turn started there: the request's own run is refused by the turn lock.
 */
const configPath = fileURLToPath(new URL('./workers/turn-outlives-browser.wrangler.toml', import.meta.url))
const ANSWER = [...Array.from({ length: 9 }, (_, index) => `Part ${index + 1}. `), 'Final answer.'].join('')
const MEMBER = { cookie: 'session=member' }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

interface State { answers: string[]; status: string | null; lock: unknown; marks: string[] }

async function until<T>(read: () => Promise<T | null>, label: string, ms: number): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out after ${ms} ms: ${label}`)
    await sleep(500)
  }
}

/** The answer text a replay carries: every text event, in order. */
function replayedText(body: string): string {
  return body.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
    .map(line => (line.kind === 'event' ? line.event : line) as Record<string, unknown>)
    .filter(event => event.type === 'text').map(event => String(event.text)).join('')
}

it('finishes, stores and replays a member’s turn after the browser that sent it disconnects', async () => {
  const worker = createTestHarness({ workers: [{ configPath }] })
  try {
    const { url } = await worker.listen()
    assert.equal((await fetch(new URL('/seed', url), { method: 'POST' })).status, 204)
    const send = (headers: Record<string, string>, signal?: AbortSignal,
      body = { threadId: 'slow-thread', turnId: 'slow-turn', content: 'Answer slowly.' }) => fetch(new URL('/chat/proof-workspace', url), {
      method: 'POST', signal, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    })
    const state = async (turnId: string, thread = 'slow-thread') =>
      await (await fetch(new URL(`/state/proof-workspace/${turnId}?thread=${thread}`, url))).json() as State

    const objectRequests = (marks: string[]) => marks.filter(kind => kind === 'host:object-request').length
    const anonymous = await send({})
    assert.equal(anonymous.status, 401, 'A caller with no credential is refused')
    assert.equal(objectRequests((await state('none')).marks), 0, 'A request with no credential is refused without creating a turn-stream object')
    const refused = await send({ cookie: 'session=stranger' })
    assert.equal(refused.status, 401, 'A caller without the member cookie is refused before any turn starts')

    const browser = new AbortController()
    const sentAt = Date.now()
    const response = await send(MEMBER, browser.signal)
    assert.equal(response.status, 200)
    const turnId = response.headers.get('x-turn-id')
    assert(turnId, 'The turn names its replay handle')
    assert.equal((await response.body!.getReader().read()).done, false, 'The browser received the turn marker')
    await sleep(Math.max(0, 2_000 - (Date.now() - sentAt)))
    browser.abort()
    const disconnectedAt = Date.now()

    const settled = await until(async () => {
      const current = await state(turnId)
      return current.answers.length > 0 && current.lock === null ? current : null
    }, 'the answer row is stored and the lock released after the browser disconnected', 100_000)
    const settledAfterMs = Date.now() - disconnectedAt
    console.info(JSON.stringify({ proof: 'turn-outlives-browser', disconnectedAfterMs: disconnectedAt - sentAt, settledAfterMs, marks: [...new Set(settled.marks)] }))
    assert.deepEqual(settled.answers, [ANSWER])
    assert.equal(settled.status, 'complete')
    assert(settledAfterMs > 30_000, `The turn kept answering for more than 30 s after the browser left: ${settledAfterMs} ms`)

    const replay = await fetch(new URL(`/replay/proof-workspace/${turnId}`, url), { headers: MEMBER })
    assert.equal(replay.status, 200)
    assert.equal(replayedText(await replay.text()), ANSWER, 'A reconnect replays the whole answer')

    assert.deepEqual([...new Set(settled.marks.filter(kind => kind.startsWith('wait-until:')))], ['wait-until:object'],
      'The turn-stream object’s waitUntil held the turn’s work; the browser request’s held none of it')
    assert.deepEqual(settled.marks.filter(kind => kind.startsWith('produce:')), ['produce:object'],
      'The producer ran once, in the turn-stream object')
    assert.equal(objectRequests(settled.marks), 2,
      'Each request with a credential, the refused stranger’s and the member’s, went to its own turn-stream object')

    // The host loses its object after the turn started there, with a plain error, so the request runs the turn itself.
    // The turn lock the object holds refuses that second run: the turn runs once.
    const producedBefore = settled.marks.filter(kind => kind.startsWith('produce:')).length
    const broken = await send({ ...MEMBER, 'x-proof-host-breaks': '1' }, undefined,
      { threadId: 'break-thread', turnId: 'break-turn', content: 'Answer soon.' })
    const refusal = await broken.text()
    assert.equal(broken.status, 409, `The lock refuses the request's second run instead of streaming it: ${refusal}`)
    assert.equal((JSON.parse(refusal) as { error?: { code?: string } }).error?.code, 'workspace_turn_in_flight')
    const afterBreak = await until(async () => {
      const current = await state('none', 'break-thread')
      return current.answers.length > 0 && current.lock === null ? current : null
    }, 'the object’s turn stores its answer after its host lost it', 60_000)
    assert.deepEqual(afterBreak.answers, [ANSWER], 'The object’s turn completed and stored exactly one answer row')
    assert.deepEqual(afterBreak.marks.filter(kind => kind.startsWith('produce:')).slice(producedBefore), ['produce:object'],
      'Only the object produced the turn; the request never ran a producer')
  } finally {
    await worker.close()
  }
}, 240_000)

// The runtime check behind the proof, run on demand: does local workerd cancel a Worker request's own waitUntil work
// after its client disconnects, as Cloudflare does? It reports the last mark and never fails on it: a last mark near
// 45 s means workerd does not cancel the work, one near 32 s means it does, and 0 means the work never ran.
it.runIf(process.env.WORKERD_WAIT_UNTIL_PROBE === '1')('measures how long a Worker request’s waitUntil work runs after its client disconnects', async () => {
  // test-quality:probe-only — a measurement printed for the reader, not an assertion.
  const worker = createTestHarness({ workers: [{ configPath }] })
  try {
    const { url } = await worker.listen()
    await fetch(new URL('/seed', url), { method: 'POST' })
    const client = new AbortController()
    const sent = fetch(new URL('/probe/wait-until', url), { signal: client.signal }).catch(() => null)
    await sleep(2_000)
    client.abort()
    await sent
    await sleep(50_000)
    const { marks } = await (await fetch(new URL('/state/probe-workspace/none', url))).json() as State
    const lastMarkSecond = Math.max(0, ...marks.filter(kind => kind.startsWith('probe:')).map(kind => Number(kind.slice('probe:'.length))))
    console.info(JSON.stringify({ probe: 'workerd-wait-until-after-disconnect', disconnectedAfterMs: 2_000, plannedMarks: 45, lastMarkSecond }))
  } finally {
    await worker.close()
  }
}, 300_000)

it('commits a quiet native admission before its own HTTP write, preserves SQL refusal and survives reader disconnect', async () => {
  const root = process.env.AGENT_APP_QUALIFICATION_EVIDENCE_DIR ?? tmpdir()
  await mkdir(root, { recursive: true })
  const evidence = await mkdtemp(join(root, 'native-admission-'))
  const worker = createTestHarness({ workers: [{ configPath }] })
  type Snapshot = {
    arm: string; turnId: string; finished: boolean; clientCancelled: boolean; returned: string[]
    error?: { name: string; message: string }; terminalError?: { name: string; message: string }
    appends: Array<{ rows: Array<{ seq: number; event: string }>; invokedAt: number; sqlSettledAt?: number; confirmedAt?: number; error?: { name: string; message: string } }>
    writes: Array<{ line: string; invokedAt: number; returnedAt?: number; error?: { name: string; message: string } }>
    rows: Array<{ seq: number; event: string }>; status: string | null
  }
  const records: Array<{ arm: string; wire: string; readerEnded: boolean; readerError?: { name: string; message: string }; snapshots: Array<{ label: string; state: Snapshot }> }> = []
  const clients: Array<{ arm: string; abort: AbortController; drained: Promise<void> }> = []
  const cleanupErrors: string[] = []
  let failure: unknown, url: URL | undefined, workerClosed = false, passed = false
  const inner = (raw: string) => { const event = JSON.parse(raw); return event.kind === 'event' ? event.event : event }
  const admissionRows = (state: Snapshot) => state.rows.filter(row => inner(row.event).type === 'execution.started')
  const admissionWrites = (state: Snapshot) => state.writes.filter(write => inner(write.line).type === 'execution.started')
  const state = async (arm: string): Promise<Snapshot> => {
    const response = await fetch(new URL('/admission-state/' + arm, url!), { headers: MEMBER })
    assert.equal(response.status, 200)
    return response.json() as Promise<Snapshot>
  }
  const release = async (arm: string, input: { confirmation?: boolean; progress?: boolean; terminal?: boolean }) => {
    const response = await fetch(new URL('/admission-release/' + arm, url!), { method: 'POST', headers: { ...MEMBER, 'content-type': 'application/json' }, body: JSON.stringify(input) })
    assert.equal(response.status, 204)
  }
  const snapshot = async (arm: string, label: string) => {
    const result = await state(arm)
    const record = records.find(record => record.arm === arm)!
    assert(record.snapshots.length < 64, 'Admission evidence observation bound exceeded')
    record.snapshots.push({ label, state: result })
    return result
  }
  const start = async (arm: string) => {
    const abort = new AbortController()
    const response = await fetch(new URL('/admission-start/' + arm, url!), { method: 'POST', headers: MEMBER, signal: abort.signal })
    assert.equal(response.status, 200)
    const record: typeof records[number] = { arm, wire: '', readerEnded: false, snapshots: [] }
    records.push(record)
    const reader = response.body!.getReader()
    const drained = (async () => {
      const decoder = new TextDecoder()
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          record.wire += decoder.decode(next.value, { stream: true })
          assert(Buffer.byteLength(record.wire) <= 64 * 1024, 'Admission HTTP evidence bound exceeded')
        }
        record.wire += decoder.decode()
        record.readerEnded = true
      } catch (error) { record.readerError = { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) } }
      finally { reader.releaseLock() }
    })()
    clients.push({ arm, abort, drained })
    return record
  }
  try {
    url = (await worker.listen()).url
    assert.equal((await fetch(new URL('/seed', url), { method: 'POST' })).status, 204)
    assert.equal((await fetch(new URL('/admission-start/healthy', url), { method: 'POST' })).status, 401)
    const healthyWire = await start('healthy')
    const first = await until(async () => {
      const current = await state('healthy')
      const nativeAppend = current.appends.some(append => append.sqlSettledAt && append.rows.some(row => inner(row.event).type === 'execution.started'))
      return nativeAppend || admissionWrites(current).length > 0 ? current : null
    }, 'either the actual native SQL settles or the old live admission is exposed', 30_000)
    if (admissionWrites(first).length) {
      // Baseline is decided by real bytes, never waiting for an append the old
      // source does not start. This observation changes no production policy.
      await until(async () => healthyWire.wire.includes('execution.started') ? healthyWire.wire : null,
        'the old native admission actually reaches the owned HTTP reader', 30_000)
    }
    const held = await snapshot('healthy', 'quiet admission before append confirmation release')
    assert.equal(admissionWrites(held).length, 0,
      'Actual native admission must not reach the tap-owned HTTP writer before its real SQL append confirms')
    assert.equal(held.returned.includes('admission'), false, 'onEvent cannot acknowledge admission before actual append confirmation')
    const nativeAppend = held.appends.find(append => append.rows.some(row => inner(row.event).type === 'execution.started'))
    assert(nativeAppend && nativeAppend.sqlSettledAt && nativeAppend.confirmedAt === undefined,
      'The real D1 append ran; only its confirmation remains held')
    assert.equal(admissionRows(held).length, 1)
    assert.equal(held.status, 'running')
    await release('healthy', { confirmation: true })
    await until(async () => (await state('healthy')).returned.includes('admission') ? true : null,
      'the actual admission onEvent resolves after real append confirmation', 30_000)
    const confirmed = await snapshot('healthy', 'real append confirmed and exact admission write completed')
    const exactWrite = admissionWrites(confirmed)[0]!
    const exactAppend = confirmed.appends.find(append => append.rows.some(row => inner(row.event).type === 'execution.started'))!
    assert(exactAppend.confirmedAt! <= exactWrite.invokedAt)
    assert.equal(exactWrite.line, admissionRows(confirmed)[0]!.event, 'Exactly the persisted original admission bytes reach the HTTP writer')
    assert.deepEqual(confirmed.rows.map(row => row.seq), [1, 2])
    assert.deepEqual(confirmed.rows.map(row => inner(row.event).type), ['text', 'execution.started'])
    assert.equal(inner(confirmed.rows[0]!.event).text, 'prefix ')
    await release('healthy', { progress: true })
    await until(async () => (await state('healthy')).returned.includes('progress') ? true : null,
      'matching admission and ordinary following progress return', 30_000)
    await snapshot('healthy', 'matching admission stays ordered while ordinary progress waits for its existing coalescing window')
    await release('healthy', { terminal: true })
    await until(async () => (await state('healthy')).finished ? true : null, 'healthy tap owner settles', 30_000)
    const healthy = await snapshot('healthy', 'healthy original terminal completed')
    assert.equal(healthy.error, undefined); assert.equal(healthy.terminalError, undefined); assert.equal(healthy.status, 'complete')
    assert.deepEqual(healthy.rows.map(row => row.seq), [1, 2, 3, 4])
    assert.deepEqual(healthy.rows.map(row => inner(row.event).type), ['text', 'execution.started', 'execution.started', 'text'])
    assert.deepEqual(admissionRows(healthy).map(row => inner(row.event).data), Array.from({ length: 2 }, () => ({ sandboxId: 'proof-box', sessionId: 'proof-native-session', executionId: 'native-healthy' })))
    assert.equal(inner(healthy.rows[3]!.event).text, 'AB', 'Ordinary following deltas remain concatenation-preserving and coalesced')
    await clients[0]!.drained
    assert.equal(healthyWire.readerEnded, true); assert.equal(healthyWire.readerError, undefined)
    assert.deepEqual(healthyWire.wire.trim().split('\n').slice(1).filter(line => inner(line).type === 'execution.started'), admissionRows(healthy).map(row => row.event))

    const failureWire = await start('sql-failure')
    await until(async () => (await state('sql-failure')).finished ? true : null, 'actual SQLite refusal returns through the tap owner', 30_000)
    const refused = await snapshot('sql-failure', 'real SQLite append rejection prevents admission acknowledgement and write')
    assert(refused.error?.message.includes('proof-native-admission-sql-refusal'))
    assert(refused.appends.some(append => append.error?.message.includes('proof-native-admission-sql-refusal')))
    assert.equal(refused.returned.includes('admission'), false)
    assert.deepEqual(admissionWrites(refused), [])
    assert.deepEqual(admissionRows(refused), [])
    assert.equal(refused.status, 'error'); assert.equal(refused.terminalError, undefined)
    await clients[1]!.drained
    assert(!failureWire.wire.includes('execution.started'))

    const disconnectWire = await start('disconnect')
    await until(async () => {
      const current = await state('disconnect')
      return current.appends.some(append => append.sqlSettledAt && !append.confirmedAt && append.rows.some(row => inner(row.event).type === 'execution.started')) ? current : null
    }, 'real disconnect-arm admission SQL settles before its confirmation is released', 30_000)
    await snapshot('disconnect', 'actual admission SQL done while HTTP client still waits')
    clients[2]!.abort.abort()
    await clients[2]!.drained
    assert(disconnectWire.readerError, 'The actual HTTP reader was severed')
    await until(async () => (await state('disconnect')).clientCancelled ? true : null, 'workerd observes the actual HTTP stream cancellation', 30_000)
    await release('disconnect', { confirmation: true, progress: true, terminal: true })
    await until(async () => (await state('disconnect')).finished ? true : null, 'disconnected tap owner completes its original store operation', 30_000)
    const disconnected = await snapshot('disconnect', 'persisted admission survives actual closed-writer failure')
    assert.equal(disconnected.clientCancelled, true)
    assert.equal(disconnected.error, undefined); assert.equal(disconnected.terminalError, undefined)
    assert.equal(disconnected.returned.includes('admission'), true)
    assert.equal(admissionRows(disconnected).length, 1)
    assert.equal(admissionWrites(disconnected).length, 1)
    assert(admissionWrites(disconnected)[0]!.error, 'The real canceled stream rejected its writer; the tap swallowed that failure')
    assert.equal(disconnected.status, 'complete')
    passed = true
  } catch (error) { failure = error }
  finally {
    for (const client of clients) {
      try {
        await release(client.arm, { confirmation: true, progress: true, terminal: true })
        await until(async () => (await state(client.arm)).finished ? true : null, 'owned tap cleanup finishes ' + client.arm, 30_000)
        await snapshot(client.arm, 'final actual owner cleanup complete')
      } catch (error) { cleanupErrors.push(client.arm + ': ' + (error instanceof Error ? error.message : String(error))) }
      client.abort.abort()
      await client.drained
    }
    try { await worker.close(); workerClosed = true }
    catch (error) { cleanupErrors.push('harness: ' + (error instanceof Error ? error.message : String(error))) }
    const report = { passed, failure: failure instanceof Error ? { name: failure.name, message: failure.message } : null,
      records, cleanupErrors, workerClosed, cleanupComplete: workerClosed && cleanupErrors.length === 0,
      limits: 'Real local HTTP/workerd/D1/tap only; no Runtime enqueue-before-hook, native backend, key, paid model or physical termination claim' }
    const bytes = JSON.stringify(report, null, 2) + '\n'
    assert(Buffer.byteLength(bytes) <= 256 * 1024, 'Admission evidence bound exceeded')
    await writeFile(join(evidence, 'receipt.json'), bytes, { mode: 0o600 })
    console.info('Actual shared admission final status:', JSON.stringify({ evidence, passed, workerClosed, cleanupComplete: report.cleanupComplete }))
  }
  if (failure) throw failure
  assert.deepEqual(cleanupErrors, [])
  assert(passed && workerClosed)
}, 240_000)
