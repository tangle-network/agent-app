import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { channel } from 'node:diagnostics_channel'
import { Socket } from 'node:net'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { createTestHarness } from 'wrangler'
import { createBufferedTurnTap, createD1TurnEventStore } from '../src/stream/turn-buffer'

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

it('commits native admission before writes and preserves D1 through HTTP loss and a real canceled writer', async () => {
  const caseStartedAt = Date.now()
  const observationDeadline = caseStartedAt + 180_000
  const cleanupDeadline = caseStartedAt + 230_000
  const receiptDeadline = caseStartedAt + 237_000 // Existing case bound remains 240 s.
  const root = process.env.AGENT_APP_QUALIFICATION_EVIDENCE_DIR ?? tmpdir()
  let evidence: string | undefined
  let worker: ReturnType<typeof createTestHarness> | undefined
  type AdmissionResponse = Response | Awaited<ReturnType<ReturnType<typeof createTestHarness>['fetch']>>
  type Snapshot = {
    arm: string; turnId: string; finished: boolean; clientCancelled: boolean; returned: string[]
    error?: { name: string; message: string }; terminalError?: { name: string; message: string }
    appends: Array<{ rows: Array<{ seq: number; event: string }>; invokedAt: number; sqlSettledAt?: number; confirmedAt?: number; error?: { name: string; message: string } }>
    writes: Array<{ line: string; invokedAt: number; returnedAt?: number; error?: { name: string; message: string } }>
    rows: Array<{ seq: number; event: string }>; status: string | null
  }
  type NodeCounterpart = {
    name: string; runtime: string; turnId: string; cancelCallbackCount: number; cancelMethodSettled: boolean
    readerLockReleased: boolean; admissionAcknowledged: boolean; mainFlowComplete: boolean; tapDone: boolean
    writes: Array<{ line: string; returned: boolean; error?: { name: string; message: string } }>
    rows: Array<{ seq: number; event: string }>; tail: Array<{ seq: number; event: string }>; status: string | null
    failure: { name: string; message: string } | null; terminalError: { name: string; message: string } | null; cleanupErrors: string[]
  }
  const httpCounterpart = { name: 'HTTP_DISCONNECT_COMPLETES', runtime: 'actual HTTP/socket and Workerd tap/D1', mainFlowComplete: false }
  let nodeCounterpart: NodeCounterpart | undefined, nodeProducer: Promise<void> | undefined
  let nodeTap: ReturnType<typeof createBufferedTurnTap> | undefined, nodeProducerSettled = false, nodeReaderLocked = false
  const records: Array<{ arm: string; wire: string; readerEnded: boolean; readerError?: { name: string; message: string }; snapshots: Array<{ label: string; state: Snapshot }> }> = []
  const clients: Array<{ arm: string; abort: AbortController; headers?: Promise<AdmissionResponse>; headersSettled: boolean; drained?: Promise<void>; drainSettled: boolean }> = []
  const requests: Array<{ name: string; abort: AbortController; settled: boolean; cleanup: boolean }> = []
  const stages: Array<{ name: string; state: 'pending' | 'fulfilled' | 'rejected'; deadlineObserved: boolean; error?: { name: string; message: string } }> = []
  const retained: Array<{ name: string; promise: Promise<unknown> }> = []
  const cleanupErrors: string[] = []
  let failure: unknown, url: URL | undefined, workerClosed = false, passed = false, cleaning = false
  let closeState: 'not-started' | 'pending' | 'fulfilled' | 'rejected' = 'not-started'
  const errorRecord = (error: unknown) => ({ name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) })
  // Observation deadlines retain the actual operation and its eventual result;
  // they neither cancel a close nor report an unresolved owner as closed.
  const observe = async <T,>(name: string, promise: Promise<T>, deadline: number) => {
    const stage: typeof stages[number] = { name, state: 'pending', deadlineObserved: false }
    stages.push(stage); retained.push({ name, promise })
    let value: T | undefined, error: unknown, finish!: () => void
    const settled = new Promise<void>(resolve => { finish = resolve })
    const timer = setTimeout(() => { stage.deadlineObserved = true; finish() }, Math.max(0, deadline - Date.now()))
    void promise.then(result => { value = result; stage.state = 'fulfilled'; clearTimeout(timer); finish() },
      cause => { error = cause; stage.state = 'rejected'; stage.error = errorRecord(cause); clearTimeout(timer); finish() })
    await settled
    return { stage, value, error }
  }
  const demand = async <T,>(name: string, promise: Promise<T>, deadline = observationDeadline): Promise<T> => {
    const observed = await observe(name, promise, deadline)
    if (observed.stage.state !== 'fulfilled' || observed.stage.deadlineObserved) throw observed.error ?? new Error(name + ' is unresolved at its evidence deadline; owner remains UNKNOWN')
    return observed.value!
  }
  const remaining = (deadline: number, maximum = 30_000) => {
    const milliseconds = Math.min(maximum, deadline - Date.now())
    assert(milliseconds > 0, 'Shared admission observation/cleanup budget exhausted')
    return milliseconds
  }
  type SocketState = { socketId: number; destroyed: boolean | null; readyState: string }
  type SocketEvent = { kind: string; atNs: string | null; cleanup: boolean; requestId?: number; socketId?: number; hadError?: boolean | null; code?: string; states?: SocketState[] }
  type SocketWitness = { id: number; socket: Socket; endpoint: { localAddress: string; localPort: number; remoteAddress: string; remotePort: number }; requestIds: number[]; closed: boolean; closeAtNs: string | null; closePromise: Promise<void>; removeListeners(): void; listenersRemoved: boolean }
  const socketEvents: SocketEvent[] = [], socketDiagnosticErrors: Array<{ code: string; atNs: string | null }> = []
  const socketWitnesses: SocketWitness[] = [], socketRequestIds = new WeakMap<object, number>()
  const socketTimes: Record<string, string | null> = {}
  let socketRequestCount = 0, socketMatchedSends = 0, socketDiagnosticErrorCount = 0
  let socketExpected = false, socketSubscribed = false, socketOverflow = false, socketClockFailed = false
  let socketCleanupStarted = false
  const socketNow = () => { try { return process.hrtime.bigint().toString() } catch { socketClockFailed = true; return null } }
  const socketClockOriginNs = socketNow()
  const socketDiagnosticError = (code: string) => {
    socketDiagnosticErrorCount++
    try {
      if (socketDiagnosticErrors.length < 8) socketDiagnosticErrors.push({ code, atNs: socketNow() })
      else socketOverflow = true
    } catch { socketOverflow = true }
  }
  const socketState = (witness: SocketWitness): SocketState => {
    try {
      const ready = witness.socket.readyState
      return { socketId: witness.id, destroyed: witness.socket.destroyed,
        readyState: ['opening', 'open', 'readOnly', 'writeOnly', 'closed'].includes(ready) ? ready : 'unknown' }
    } catch { socketDiagnosticError('socket-state-read'); return { socketId: witness.id, destroyed: null, readyState: 'unknown' } }
  }
  const socketEvent = (kind: string, fields: Omit<SocketEvent, 'kind' | 'atNs' | 'cleanup'> = {}) => {
    try {
      if (socketEvents.length < 32) socketEvents.push({ kind, atNs: socketNow(), cleanup: socketCleanupStarted, ...fields })
      else socketOverflow = true
    } catch { socketDiagnosticError('event-capture') }
  }
  const socketMark = (kind: string) => {
    try {
      if (!Object.hasOwn(socketTimes, kind)) socketTimes[kind] = socketNow()
      socketEvent(kind, { states: socketWitnesses.map(socketState) })
    } catch { socketDiagnosticError('mark-capture') }
  }
  const socketChannel = channel('undici:client:sendHeaders')
  const socketObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
  const onSocketHeaders = (message: unknown) => {
    try {
      if (!socketObject(message) || !socketObject(message.request)) { socketDiagnosticError('diagnostic-payload-shape'); return }
      const request = message.request
      if (typeof request.method !== 'string' || typeof request.path !== 'string') { socketDiagnosticError('diagnostic-request-shape'); return }
      if (request.method !== 'POST' || request.path !== '/admission-start/disconnect') return
      socketMatchedSends++
      const socket = message.socket
      if (!(socket instanceof Socket)) { socketDiagnosticError('diagnostic-not-socket'); return }
      let requestId = socketRequestIds.get(request)
      if (requestId === undefined) {
        if (socketRequestCount >= 4) { socketOverflow = true; socketDiagnosticError('request-cardinality'); return }
        requestId = ++socketRequestCount; socketRequestIds.set(request, requestId)
      }
      let witness = socketWitnesses.find(item => item.socket === socket)
      if (!witness) {
        if (socketWitnesses.length >= 4) { socketOverflow = true; socketDiagnosticError('socket-cardinality'); return }
        const { localAddress, localPort, remoteAddress, remotePort } = socket
        const loopback = (value: unknown): value is string => value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1'
        if (!loopback(localAddress) || !loopback(remoteAddress) || typeof localPort !== 'number' || typeof remotePort !== 'number'
          || !Number.isInteger(localPort) || !Number.isInteger(remotePort) || localPort < 1 || remotePort < 1 || localPort > 65535 || remotePort > 65535) {
          socketDiagnosticError('non-loopback-or-missing-endpoint'); return
        }
        let actualClose!: () => void
        const closePromise = new Promise<void>(resolve => { actualClose = resolve })
        const owned: SocketWitness = { id: socketWitnesses.length + 1, socket,
          endpoint: { localAddress, localPort, remoteAddress, remotePort },
          requestIds: [], closed: false, closeAtNs: null, closePromise, listenersRemoved: false, removeListeners: () => {} }
        const onClose = (hadError: boolean) => {
          // Only this actual event fulfills the retained promise; flags/errors/deadlines never do.
          owned.closed = true; owned.closeAtNs ??= socketNow()
          try { socketEvent('socket-close', { socketId: owned.id, hadError: typeof hadError === 'boolean' ? hadError : null }) }
          catch { socketDiagnosticError('socket-close-capture') }
          finally { actualClose() }
        }
        const onEnd = () => { try { socketEvent('socket-end', { socketId: owned.id }) } catch { socketDiagnosticError('socket-end-capture') } }
        const onError = (error: unknown) => {
          try {
            const code = socketObject(error) && typeof error.code === 'string' && ['UND_ERR_ABORTED', 'ECONNRESET', 'EPIPE', 'ABORT_ERR'].includes(error.code) ? error.code : 'other'
            socketEvent('socket-error', { socketId: owned.id, code })
          } catch { socketDiagnosticError('socket-error-capture') }
        }
        owned.removeListeners = () => {
          try { socket.off('close', onClose); socket.off('end', onEnd); socket.off('error', onError); owned.listenersRemoved = true }
          catch { socketDiagnosticError('socket-listener-cleanup') }
        }
        socketWitnesses.push(owned); retained.push({ name: 'actual-socket-close:' + owned.id, promise: closePromise })
        socket.on('close', onClose); socket.on('end', onEnd); socket.on('error', onError)
        witness = owned
      }
      if (!witness.requestIds.includes(requestId)) witness.requestIds.push(requestId)
      socketEvent('send-headers', { requestId, socketId: witness.id, states: [socketState(witness)] })
    } catch { socketDiagnosticError('diagnostic-callback') }
  }
  const startSocketObservation = () => {
    socketExpected = true
    try { socketChannel.subscribe(onSocketHeaders); socketSubscribed = true; socketMark('diagnostics-subscribed') }
    catch { socketDiagnosticError('diagnostic-subscribe') }
  }
  const unsubscribeSocketObservation = () => {
    if (!socketSubscribed) return
    try { socketChannel.unsubscribe(onSocketHeaders); socketSubscribed = false; socketMark('diagnostics-unsubscribed') }
    catch { socketDiagnosticError('diagnostic-unsubscribe') }
  }
  const socketObservation = () => {
    const sockets = socketWitnesses.map(witness => ({ socketId: witness.id, requestIds: [...witness.requestIds], endpoint: witness.endpoint,
      state: socketState(witness), actualCloseObserved: witness.closed, closeAtNs: witness.closeAtNs,
      actualClosePromiseState: witness.closed ? 'fulfilled' : 'pending', listenersRemoved: witness.listenersRemoved }))
    return {
      clock: 'Node process.hrtime.bigint nanoseconds; do not compare to Worker Date.now', clockOriginNs: socketClockOriginNs,
      collectionWindow: 'sendHeaders from disconnect start through precleanup partial receipt; captured socket events through ordinary cleanup deadline',
      expected: socketExpected, subscribed: socketSubscribed, matchedSends: socketMatchedSends, requestCount: socketRequestCount,
      confidence: !socketExpected ? 'NOT_STARTED' : socketOverflow || socketClockFailed || socketDiagnosticErrorCount > 0 ? 'UNKNOWN_CAPTURE' : socketRequestCount === 1 && socketWitnesses.length === 1 ? 'UNIQUE_REQUEST_AND_SOCKET' : 'UNKNOWN_MISSING_OR_MULTIPLE',
      overflow: socketOverflow, diagnosticErrorCount: socketDiagnosticErrorCount, diagnosticErrors: [...socketDiagnosticErrors],
      method: 'POST', path: '/admission-start/disconnect', times: { ...socketTimes }, events: [...socketEvents], sockets,
    }
  }
  const inner = (raw: string) => { const event = JSON.parse(raw); return event.kind === 'event' ? event.event : event }
  const admissionRows = (state: Snapshot) => state.rows.filter(row => inner(row.event).type === 'execution.started')
  const admissionWrites = (state: Snapshot) => state.writes.filter(write => inner(write.line).type === 'execution.started')
  const http = async (name: string, path: string, init: RequestInit = {}, json = false) => {
    const deadline = Math.min(cleaning ? cleanupDeadline : observationDeadline, Date.now() + 30_000)
    const abort = new AbortController(), owner = { name, abort, settled: false, cleanup: cleaning }
    requests.push(owner) // Own the abort before starting or awaiting headers.
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(remaining(deadline))])
    const actual = (async () => {
      const response = await fetch(new URL(path, url!), { ...init, headers: { ...MEMBER, ...init.headers }, signal })
      const body: unknown = json ? await response.json() : await response.text()
      return { status: response.status, body }
    })()
    void actual.then(() => { owner.settled = true }, () => { owner.settled = true })
    return demand('http:' + name, actual, deadline) // One budget covers headers AND body.
  }
  const state = async (arm: string): Promise<Snapshot> => {
    const response = await http('state:' + arm, '/admission-state/' + arm, {}, true)
    assert.equal(response.status, 200)
    return response.body as Snapshot
  }
  const release = async (arm: string, input: { confirmation?: boolean; progress?: boolean; terminal?: boolean }) => {
    const response = await http('release:' + arm, '/admission-release/' + arm, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
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
    if (arm === 'disconnect') startSocketObservation()
    const abort = new AbortController()
    const record: typeof records[number] = { arm, wire: '', readerEnded: false, snapshots: [] }
    const client: typeof clients[number] = { arm, abort, headersSettled: false, drainSettled: false }
    records.push(record); clients.push(client) // Register the real request owner BEFORE awaiting headers.
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(remaining(observationDeadline, observationDeadline - Date.now()))])
    client.headers = arm === 'disconnect'
      ? worker!.getWorker().fetch(new URL('/admission-start/' + arm, url!), { method: 'POST', headers: MEMBER, signal })
      : fetch(new URL('/admission-start/' + arm, url!), { method: 'POST', headers: MEMBER, signal })
    void client.headers.then(() => { client.headersSettled = true }, () => { client.headersSettled = true; client.drainSettled = true })
    const response = await demand('start-headers:' + arm, client.headers, Math.min(observationDeadline, Date.now() + 30_000))
    assert.equal(response.status, 200)
    const reader = response.body!.getReader()
    client.drained = (async () => {
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
      } catch (error) { record.readerError = errorRecord(error); if (arm === 'disconnect') socketMark('reader-error-observed') }
      finally { reader.releaseLock() }
    })()
    void client.drained.then(() => { client.drainSettled = true; if (arm === 'disconnect') socketMark('reader-drain-fulfilled') }, () => { client.drainSettled = true; if (arm === 'disconnect') socketMark('reader-drain-rejected') })
    return record
  }
  const ownership = () => [
    ...(nodeProducer && !nodeProducerSettled ? [{ resource: 'node-canceled-reader-producer', state: 'OWNED_UNKNOWN' }] : []),
    ...(nodeReaderLocked ? [{ resource: 'node-stream-reader-lock', state: 'OWNED_UNKNOWN' }] : []),
    ...(nodeTap && !nodeCounterpart?.tapDone ? [{ resource: 'node-buffered-tap-finalization', state: 'OWNED_UNKNOWN' }] : []),
    ...socketWitnesses.filter(witness => !witness.closed).map(witness => ({ resource: 'actual-socket-close:' + witness.id, state: 'OWNED_UNKNOWN' })),
    ...socketWitnesses.filter(witness => !witness.listenersRemoved).map(witness => ({ resource: 'socket-listeners:' + witness.id, state: 'OWNED_UNKNOWN' })),
    ...(socketSubscribed ? [{ resource: 'diagnostics-subscription', state: 'OWNED_UNKNOWN' }] : []),
    ...clients.filter(client => !client.headersSettled || !client.drainSettled).map(client => ({ resource: 'http-reader:' + client.arm, state: 'OWNED_UNKNOWN' })),
    ...requests.filter(request => !request.settled).map(request => ({ resource: 'http-request:' + request.name, state: 'OWNED_UNKNOWN' })),
    ...(worker && !workerClosed ? [{ resource: 'workerd-harness', state: 'OWNED_UNKNOWN', closeState }] : []),
    ...stages.filter(stage => stage.state === 'pending' && stage.deadlineObserved).map(stage => ({ resource: 'operation:' + stage.name, state: 'OWNED_UNKNOWN' })),
  ]
  const receipt = (kind: string) => ({ kind, testHost: { node: process.version, pid: process.pid }, passed, failure: failure ? errorRecord(failure) : null, records, stages,
    counterparts: { http: httpCounterpart, node: nodeCounterpart }, socketObservation: socketObservation(), cleanupErrors, workerClosed, closeState, ownedResources: ownership(), retainedOperationNames: retained.map(operation => operation.name),
    cleanupComplete: workerClosed && cleanupErrors.length === 0 && ownership().length === 0,
    limits: 'Real local HTTP/workerd/D1/tap only; deadlines observe retained operations, never fake closure; no Runtime pre-enqueue/native backend/key/paid model/physical termination claim' })
  const writeReceipt = (name: string, kind: string, deadline: number) => {
    assert(evidence, 'Evidence directory unavailable')
    let report: unknown = receipt(kind), bytes = JSON.stringify(report, null, 2) + '\n'
    if (Buffer.byteLength(bytes) > 256 * 1024) {
      cleanupErrors.push('receipt-overflow: observations UNKNOWN')
      report = { kind, failure: failure ? errorRecord(failure) : null, captureOverflow: true, originalBytes: Buffer.byteLength(bytes), ownedResources: ownership(), workerClosed, cleanupComplete: false }
      bytes = JSON.stringify(report, null, 2) + '\n'
    }
    return writeFile(join(evidence, name), bytes, { mode: 0o600, signal: AbortSignal.timeout(remaining(deadline, 3_000)) })
  }
  try {
    await demand('evidence-root', mkdir(root, { recursive: true }))
    evidence = await demand('evidence-directory', mkdtemp(join(root, 'native-admission-')))
    worker = createTestHarness({ workers: [{ configPath }] })
    url = (await demand('harness-listen', worker.listen())).url
    assert.equal((await http('seed', '/seed', { method: 'POST' })).status, 204)
    assert.equal((await http('anonymous-refusal', '/admission-start/healthy', { method: 'POST', headers: { cookie: '' } })).status, 401)
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
    await demand('reader-drain:healthy', clients[0]!.drained!)
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
    await demand('reader-drain:sql-failure', clients[1]!.drained!)
    assert(!failureWire.wire.includes('execution.started'))

    const disconnectWire = await start('disconnect')
    await until(async () => {
      const current = await state('disconnect')
      return current.appends.some(append => append.sqlSettledAt && !append.confirmedAt && append.rows.some(row => inner(row.event).type === 'execution.started')) ? current : null
    }, 'real disconnect-arm admission SQL settles before its confirmation is released', 30_000)
    await snapshot('disconnect', 'actual admission SQL done while HTTP client still waits')
    socketMark('before-original-abort')
    clients[2]!.abort.abort()
    socketMark('after-original-abort')
    await demand('reader-drain:disconnect', clients[2]!.drained!)
    assert(disconnectWire.readerError, 'The actual HTTP reader was severed')
    assert.equal(socketObservation().confidence, 'UNIQUE_REQUEST_AND_SOCKET')
    assert.equal(socketMatchedSends, 1)
    const actualSocket = socketWitnesses[0]!
    await demand('http-actual-socket-close-before-release', actualSocket.closePromise, Math.min(observationDeadline, Date.now() + 30_000))
    assert.equal(socketObservation().confidence, 'UNIQUE_REQUEST_AND_SOCKET')
    assert(actualSocket.closed && actualSocket.closeAtNs && socketTimes['before-original-abort'])
    assert(BigInt(actualSocket.closeAtNs) >= BigInt(socketTimes['before-original-abort']))
    socketMark('http-confirmation-release-started')
    assert(socketTimes['http-confirmation-release-started'])
    assert(BigInt(actualSocket.closeAtNs) < BigInt(socketTimes['http-confirmation-release-started']))
    assert.equal(cleaning, false, 'Physical HTTP socket retirement precedes main-flow release and cleanup')
    await release('disconnect', { confirmation: true, progress: true, terminal: true })
    await until(async () => (await state('disconnect')).finished ? true : null, 'disconnected tap owner completes its original store operation', 30_000)
    const disconnected = await snapshot('disconnect', 'HTTP_DISCONNECT_COMPLETES: original producer and D1 complete before cleanup')
    assert.equal(disconnected.error, undefined); assert.equal(disconnected.terminalError, undefined)
    assert.equal(disconnected.returned.includes('admission'), true)
    assert.equal(admissionRows(disconnected).length, 1)
    assert.equal(admissionWrites(disconnected).length, 1)
    const persistedAdmission = admissionRows(disconnected)[0]!
    const attemptedAdmission = admissionWrites(disconnected)[0]!
    const confirmedAppend = disconnected.appends.find(append => append.rows.some(row => row.event === persistedAdmission.event))!
    assert(confirmedAppend.confirmedAt && confirmedAppend.sqlSettledAt)
    assert(confirmedAppend.confirmedAt <= attemptedAdmission.invokedAt)
    assert.equal(attemptedAdmission.line, persistedAdmission.event)
    assert.deepEqual(inner(persistedAdmission.event).data, { sandboxId: 'proof-box', sessionId: 'proof-native-session', executionId: 'native-disconnect' })
    assert.deepEqual(disconnected.rows.map(row => row.seq), [1, 2])
    assert.deepEqual(disconnected.rows.map(row => inner(row.event).type), ['text', 'execution.started'])
    assert.equal(inner(disconnected.rows[0]!.event).text, 'prefix ')
    assert.equal(disconnected.status, 'complete')
    assert.equal(disconnected.finished, true)
    assert.equal(cleaning, false, 'HTTP producer acknowledgement and actual D1 completion precede test cleanup')
    httpCounterpart.mainFlowComplete = true
    socketMark('http-main-flow-complete')

    // Generic tap + Node standard Web Streams; only DB operations execute in Workerd.
    const { DB } = await demand('node-counterpart-public-env', worker.getWorker<{ DB: Parameters<typeof createD1TurnEventStore>[0] }>().getEnv())
    const actualStore = createD1TurnEventStore(DB)
    const turnId = 'real-reader-cancel-' + crypto.randomUUID()
    const node: NodeCounterpart = nodeCounterpart = {
      name: 'REAL_READER_CANCEL_D1_WRITER_REJECTION', runtime: 'Node standard Web Streams/tap; actual Workerd D1 binding', turnId,
      cancelCallbackCount: 0, cancelMethodSettled: false, readerLockReleased: false, admissionAcknowledged: false,
      mainFlowComplete: false, tapDone: false, writes: [], rows: [], tail: [], status: null,
      failure: null, terminalError: null, cleanupErrors: [],
    }
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value },
      cancel() { node.cancelCallbackCount++ },
    })
    const reader = body.getReader(); nodeReaderLocked = true
    let realEnqueueError: unknown
    const tap = nodeTap = createBufferedTurnTap({ turnId, scopeId: 'real-reader-cancel-proof', store: actualStore,
      write: line => {
        const write: typeof node.writes[number] = { line, returned: false }; node.writes.push(write)
        try { controller.enqueue(new TextEncoder().encode(line + '\n')); write.returned = true }
        catch (error) { realEnqueueError = error; write.error = errorRecord(error); throw error }
      },
    })
    // One actual task owns every onEvent/done/reader operation. Cleanup never races a second done.
    nodeProducer = (async () => {
      try {
        await tap.onEvent({ type: 'text', text: 'node prefix ' })
        const prefix = await reader.read()
        assert.equal(prefix.done, false)
        assert.equal(new TextDecoder().decode(prefix.value), node.writes[0]!.line + '\n')
        assert.equal(inner(node.writes[0]!.line).text, 'node prefix ')
        await reader.cancel('owned-reader-cancel-proof'); node.cancelMethodSettled = true
        assert.equal(node.cancelCallbackCount, 1, 'Only actual reader.cancel invokes the real underlying callback')
        reader.releaseLock(); nodeReaderLocked = false; node.readerLockReleased = true
        const admission = { kind: 'event', event: { type: 'execution.started', data: {
          sandboxId: 'proof-node-box', sessionId: 'proof-node-session', executionId: 'native-node-canceled-reader',
        } } }
        await tap.onEvent(admission); node.admissionAcknowledged = true
        assert(realEnqueueError instanceof TypeError, 'Actual enqueue against the canceled controller must throw')
        assert.equal(node.writes.length, 2)
        const attempted = node.writes[1]!
        assert.equal(attempted.returned, false)
        assert.deepEqual(attempted.error, errorRecord(realEnqueueError))
        assert.deepEqual(inner(attempted.line), admission.event)
        const admitted = await actualStore.read(turnId, 0)
        assert.deepEqual(admitted.map(row => row.seq), [1, 2])
        assert.equal(admitted[1]!.event, attempted.line, 'The acknowledged original admission bytes are already in actual D1')
        assert.equal(inner(admitted[0]!.event).text, 'node prefix ')
        await tap.onEvent({ type: 'text', text: 'later AB' })
        await tap.done('complete'); node.tapDone = true
        node.rows = await actualStore.read(turnId, 0)
        node.status = await actualStore.getStatus(turnId)
        assert(actualStore.readTail, 'The maintained actual D1 store supplies its real tail query')
        node.tail = await actualStore.readTail(turnId, 2)
        assert.equal(node.status, 'complete')
        assert.deepEqual(node.rows.map(row => row.seq), [1, 2, 3])
        assert.deepEqual(node.rows.map(row => inner(row.event).type), ['text', 'execution.started', 'text'])
        assert.equal(node.rows[1]!.event, attempted.line)
        assert.equal(inner(node.rows[2]!.event).text, 'later AB')
        assert.equal(node.rows.filter(row => inner(row.event).type === 'text').map(row => inner(row.event).text).join(''), 'node prefix later AB')
        assert.deepEqual(node.tail, node.rows.slice(-2).reverse())
        assert.equal(node.writes.length, 2, 'The real writer failure suppresses every later live write, without losing later persistence')
        assert.equal(node.writes.filter(write => inner(write.line).type === 'execution.started' && write.returned).length, 0)
        assert.equal(cleaning, false, 'Actual Node tap completion and D1 reads precede test cleanup')
        node.mainFlowComplete = true
      } catch (error) { node.failure = errorRecord(error); throw error }
      finally {
        if (!node.tapDone) {
          try { await tap.done('error'); node.tapDone = true }
          catch (error) { node.terminalError = errorRecord(error) }
        }
        if (nodeReaderLocked) {
          try { await reader.cancel('owned-reader-failure-cleanup'); reader.releaseLock(); nodeReaderLocked = false; node.readerLockReleased = true }
          catch (error) { node.cleanupErrors.push(errorRecord(error).message) }
        }
      }
    })()
    void nodeProducer.then(() => { nodeProducerSettled = true }, () => { nodeProducerSettled = true })
    await demand('node-canceled-reader-producer', nodeProducer)
    assert.equal(node.failure, null); assert.equal(node.terminalError, null)
    assert.deepEqual(node.cleanupErrors, [])
    passed = true
  } catch (error) { failure = error; socketMark('case-failure-observed') }
  finally {
    cleaning = true
    socketMark('finally-entered-before-partial')
    // Freeze the original failure and precleanup wire/snapshots FIRST. A
    // stalled release, reader or close cannot prevent this partial receipt.
    if (evidence) {
      try {
        const partial = await observe('partial-receipt', writeReceipt('partial.json', 'PARTIAL_BEFORE_CLEANUP', receiptDeadline), Math.min(receiptDeadline, Date.now() + 3_000))
        if (partial.stage.state !== 'fulfilled' || partial.stage.deadlineObserved) cleanupErrors.push('partial receipt write remains UNKNOWN')
      } catch (error) { cleanupErrors.push('partial receipt: ' + errorRecord(error).message) }
    }
    // Abort already-owned observation I/O, then start ALL ordinary releases
    // concurrently. No one unresolved owner serially prevents another cleanup.
    unsubscribeSocketObservation() // Freeze the matched set before transport cleanup; socket listeners remain.
    socketCleanupStarted = true; socketMark('cleanup-started')
    for (const request of requests) if (!request.cleanup && !request.settled) request.abort.abort()
    for (const client of clients) client.abort.abort()
    const releases = clients.map(async client => {
      try {
        await release(client.arm, { confirmation: true, progress: true, terminal: true })
        await until(async () => (await state(client.arm)).finished ? true : null, 'owned tap cleanup finishes ' + client.arm, 30_000)
        await snapshot(client.arm, 'final actual owner cleanup complete')
      } catch (error) { cleanupErrors.push(client.arm + ': ' + errorRecord(error).message) }
    })
    const releaseGroup = Promise.all(releases)
    const close = (async () => {
      // Give ordinary owned releases a finite chance, then start the actual
      // close even if a request has not returned. Keep both promises retained.
      await observe('cleanup-releases-before-close', releaseGroup, Math.min(cleanupDeadline, Date.now() + 10_000))
      if (nodeProducer) {
        const nodeOwner = await observe('cleanup-node-producer-before-harness-close', nodeProducer, Math.min(cleanupDeadline, Date.now() + 10_000))
        if (nodeOwner.stage.state === 'pending' || nodeOwner.stage.deadlineObserved) cleanupErrors.push('Node producer remains UNKNOWN before harness close')
      }
      if (worker) {
        closeState = 'pending'
        try { socketMark('harness-close-started'); await worker.close(); workerClosed = true; closeState = 'fulfilled'; socketMark('harness-close-fulfilled') }
        catch (error) { closeState = 'rejected'; cleanupErrors.push('harness: ' + errorRecord(error).message); throw error }
      }
    })()
    const drains = clients.map(client => {
      // A response arriving after its header-observation deadline still owns
      // a real body. Cancel that actual body if no reader was established.
      const lateBody = client.headers?.then(async response => {
        if (!client.drained) { await response.body?.cancel(); client.drainSettled = true }
      }, () => { client.drainSettled = true })
      return observe('cleanup-reader:' + client.arm,
        Promise.allSettled([...(client.headers ? [client.headers] : []), ...(client.drained ? [client.drained] : []), ...(lateBody ? [lateBody] : [])]), cleanupDeadline)
    })
    const socketCloses = socketWitnesses.map(witness => observe('cleanup-actual-socket-close:' + witness.id, witness.closePromise, cleanupDeadline))
    const completed = await Promise.all([observe('cleanup-release-group', releaseGroup, cleanupDeadline), observe('harness-close', close, cleanupDeadline), ...drains, ...socketCloses])
    for (const observed of completed) if (observed.stage.state !== 'fulfilled' || observed.stage.deadlineObserved) cleanupErrors.push(observed.stage.name + ' unresolved/failed at cleanup deadline')
    for (const request of requests) if (!request.settled) request.abort.abort()
    unsubscribeSocketObservation()
    for (const witness of socketWitnesses) witness.removeListeners()
    socketMark('socket-listeners-removed')
    if (ownership().length) cleanupErrors.push('unresolved owners remain UNKNOWN')
    if (evidence) {
      try {
        const final = await observe('final-receipt', writeReceipt('receipt.json', 'FINAL_OBSERVATION', receiptDeadline), receiptDeadline)
        if (final.stage.state !== 'fulfilled' || final.stage.deadlineObserved) cleanupErrors.push('final receipt write remains UNKNOWN')
      } catch (error) { cleanupErrors.push('final receipt: ' + errorRecord(error).message) }
      console.info('Actual shared admission final status:', JSON.stringify({ evidence, passed, workerClosed,
        cleanupComplete: workerClosed && cleanupErrors.length === 0 && ownership().length === 0, ownedResources: ownership(), stages, counterparts: { http: httpCounterpart, node: nodeCounterpart }, socketObservation: socketObservation() }))
    }
  }
  if (failure) throw failure
  assert.deepEqual(cleanupErrors, [])
  assert(passed && workerClosed)
  assert.deepEqual(ownership(), [], 'Pending operation/reader/harness owners remain UNKNOWN, never closed by a deadline race')
}, 240_000)
