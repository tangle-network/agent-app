import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Sandbox } from '@tangle-network/sandbox'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { DEFAULT_STALE_TURN_LOCK_GRACE_MS as BOUND, DEFAULT_TERMINAL_TURN_LOCK_GRACE_MS as GRACE } from '../../src/chat-routes/stale-turn-lock'
import { readHolderBoxSessions } from '../../src/sandbox/holder-box'
import { createD1TurnEventStore, TURN_EVENTS_MIGRATION_SQL } from '../../src/stream/index'
import { acquireDurableTurnLock, createDurableTurnLock, parkDurableTurnLock, type DurableTurnLock } from '../../src/turn-stream/index'
import { createMemoryTurnStreamHarness, MEMORY_TURN_STREAM_AUTH_SECRET } from '../../src/turn-stream/memory'
import { sqliteD1 } from '../launch-invariants/sqlite-d1'

/**
 * The default reclaim for a turn lock whose turn died without releasing it. The authenticated TurnStreamDO core, a
 * migrated SQLite D1 turn store, the public Sandbox SDK over a loopback HTTP peer and the shipped lock adapter with no
 * product reconcile; no SDK method or store is replaced. Time moves through the policy's injected clock (`now`), which
 * the turn store shares; a lock's start is the DO's own wall clock. The one real wait is the 5 s box read cap.
 */

// Each box's sessions as the peer serves them. The sidecar's verdict (hasActiveExecution) decides: a finished session
// can keep a stale activeExecutionId, and one with no status is read as running by the SDK.
const SESSIONS: Record<string, unknown[]> = {
  busy: [{ id: 'detached-run', status: 'running', activeExecutionId: 'detached-execution', hasActiveExecution: true }],
  finished: [{ id: 'detached-run', status: 'completed', latestExecutionId: 'detached-execution', hasActiveExecution: false },
    { id: 'stale-run', status: 'completed', activeExecutionId: 'stale-execution', hasActiveExecution: false },
    { id: 'earlier-run', latestExecutionId: 'earlier' }],
  // An older sidecar sends no verdict: its active execution id counts.
  older: [{ id: 'older-run', status: 'running', activeExecutionId: 'older-execution' }],
}
let origin = ''
const stalled: ServerResponse[] = []
const server = createServer((request, response) => {
  const path = new URL(request.url!, 'http://peer').pathname
  const json = (code: number, value: unknown) => response.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  const box = /^\/v1\/sandboxes\/([a-z]+)-box(\/runtime\/agents\/sessions)?$/.exec(path)
  if (!box) return json(404, { error: `unexpected ${request.method} ${path}` })
  const [, name = '', sessions] = box
  // A failed read the SDK does not resend (it resends 502-504 until its own deadline), and a read that never answers.
  if (name === 'down') return json(500, { error: 'box api failed: peer-detail' })
  if (name === 'slow') return void stalled.push(response)
  if (!sessions) return json(200, { id: `${name}-box`, status: 'running', filesystemIncarnationId: `${name}-incarnation`,
    filesystemIncarnationProvenance: 'fresh', filesystemIncarnationReadiness: 'ready',
    connection: { runtimeUrl: `${origin}/v1/sandboxes/${name}-box/runtime` } })
  return json(200, SESSIONS[name] ?? [])
})
let client: Sandbox
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  client = new Sandbox({ apiKey: 'local-fixture', baseUrl: origin })
})
afterAll(async () => {
  vi.restoreAllMocks()
  for (const response of stalled) response.writeHead(500).end()
  await new Promise<void>(resolve => server.close(() => resolve()))
})

let skew = 0
const clock = () => Date.now() + skew
/** Move the injected clock so the `held` lock is `ageMs` old. */
const age = (held: DurableTurnLock, ageMs: number) => { skew = held.startedAt + ageMs - Date.now() }
const turns = createD1TurnEventStore(sqliteD1(TURN_EVENTS_MIGRATION_SQL).d1, { now: clock })
const durable = createMemoryTurnStreamHarness()
const auth = { secret: MEMORY_TURN_STREAM_AUTH_SECRET }
const boxed = new Set(['busy', 'finished', 'older', 'down', 'slow'])
const lock = createDurableTurnLock<Record<string, never>>({ namespace: durable.namespace, auth, scopeOf: () => 'workspace',
  turnStore: turns, now: clock,
  readHolderBox: active => readHolderBoxSessions(async () => boxed.has(active.workspaceId) ? client.get(`${active.workspaceId}-box`) : null) })

/** A holder that took the lock and died: nothing renews or releases it. `durableStop` records what `cancellationOf` does. */
const hold = async (workspaceId: string, { durableStop = false } = {}) => {
  const held = await acquireDurableTurnLock(durable.namespace, { workspaceId, threadId: `${workspaceId}-earlier`, scope: 'workspace',
    executionId: crypto.randomUUID(), ...(durableStop ? { cancellation: { turnStreamId: `${workspaceId}-stream` } } : {}) }, auth)
  if (!held.acquired) throw new Error(`${workspaceId}: the holder could not take the lock`)
  return held.lock
}
const seen: Record<string, Record<string, unknown>> = {}
const ask = async (workspaceId: string, via = lock) => {
  const result = await via.acquire({ identity: { tenantId: workspaceId, sessionId: `${workspaceId}-new` },
    executionId: crypto.randomUUID(), context: {}, body: {} })
  if (result.acquired) return 'acquired'
  const body = (await result.response.json()) as { error: { code: string; diagnostics?: Record<string, unknown> } }
  seen[workspaceId] = body.error.diagnostics ?? {}
  return `${result.response.status} ${body.error.code}`
}

it('releases a holder with no running turn and no box work only past the 60 s grace, so a turn writes its row within it', async () => {
  const dead = await hold('dead')
  const starting = await hold('starting')
  age(dead, GRACE - 1_000)
  expect(await ask('dead')).toBe('409 workspace_turn_in_flight')
  expect(seen.dead).toMatchObject({ runningTurns: 0, liveBoxSessions: 0, terminalReleaseWithheld: 'LOCK_WITHIN_TERMINAL_GRACE_PERIOD' })
  age(starting, GRACE - 1_000)
  await turns.setStatus('starting-turn', 'running', 'starting-earlier')
  age(dead, GRACE + 1_000)
  expect(await ask('dead')).toBe('acquired')
  age(starting, GRACE + 1_000)
  expect(await ask('starting')).toBe('409 workspace_turn_in_flight')
  expect(seen.starting).toMatchObject({ runningTurns: 1 })
})

it('holds while box work runs, by the sidecar verdict or an older sidecar active id, and while a release is parked', async () => {
  const warn = vi.spyOn(console, 'warn')
  const locks = { busy: await hold('busy'), finished: await hold('finished'), older: await hold('older'), parked: await hold('parked') }
  expect(await parkDurableTurnLock(durable.namespace, { workspaceId: 'parked', threadId: 'parked-earlier', scope: 'workspace',
    executionId: locks.parked.executionId, lockId: locks.parked.lockId }, auth)).toBe(true)
  age(locks.busy, GRACE + 1_000)
  expect(await ask('busy')).toBe('409 workspace_turn_in_flight')
  expect(seen.busy).toMatchObject({ liveBoxSessions: 1, boxSessions: 1 })
  age(locks.finished, GRACE + 1_000)
  expect(await ask('finished')).toBe('acquired')
  warn.mockClear()
  age(locks.older, GRACE + 1_000)
  expect(await ask('older')).toBe('409 workspace_turn_in_flight')
  expect(seen.older).toMatchObject({ liveBoxSessions: 1, boxSessions: 1 })
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('no execution verdict'), { class: 'sidecar_verdict_absent', sessions: 1 })
  age(locks.parked, GRACE + 1_000)
  expect(await ask('parked')).toBe('409 workspace_turn_in_flight')
  expect(seen.parked).toMatchObject({ releasePending: true })
})

it('judges a durable-Stop holder by the owner rule on the same evidence: dead is released past the grace, live holds', async () => {
  const dead = await hold('stopdead', { durableStop: true })
  const live = await hold('stoplive', { durableStop: true })
  age(dead, GRACE - 1_000)
  expect(await ask('stopdead')).toBe('409 workspace_turn_in_flight')
  expect(seen.stopdead).toMatchObject({ ownerStatus: 'abandoned', releaseWithheld: 'LOCK_WITHIN_TERMINAL_GRACE_PERIOD' })
  age(dead, GRACE + 1_000)
  expect(await ask('stopdead')).toBe('acquired')
  age(live, GRACE + 1_000)
  await turns.setStatus('stoplive-turn', 'running', 'stoplive-earlier')
  expect(await ask('stoplive')).toBe('409 workspace_turn_in_flight')
  expect(seen.stoplive).toMatchObject({ ownerStatus: 'live', runningTurns: 1 })
})

it('reclaims from the turn store alone when the product reads no box', async () => {
  const storeOnly = createDurableTurnLock<Record<string, never>>({ namespace: durable.namespace, auth, scopeOf: () => 'workspace',
    turnStore: turns, now: clock })
  age(await hold('storedead'), GRACE + 1_000)
  expect(await ask('storedead', storeOnly)).toBe('acquired')
})

it('sends a failed box read and a read past the 5 s cap to the unreachable bound, each by its own class', async () => {
  const down = await hold('down')
  const slow = await hold('slow')
  age(down, GRACE + 1_000)
  expect(await ask('down')).toBe('409 workspace_turn_in_flight')
  // Classes and counts only: no status, no message from the box API.
  expect(seen.down).toEqual({ unreachableReason: 'SESSION_UNREACHABLE', sessionProbeError: 'box_unreachable', sandboxReachable: false,
    lockAgeMs: expect.any(Number), forceReleaseGraceMs: BOUND, forceReleaseWithheld: 'LOCK_WITHIN_GRACE_PERIOD' })
  age(down, BOUND + 1_000)
  expect(await ask('down')).toBe('acquired')
  // The clock runs on through the 5 s read. Age and release fence are both read before it, so the lock stays inside.
  age(slow, BOUND - 2_000)
  expect(await ask('slow')).toBe('409 workspace_turn_in_flight')
  expect(seen.slow).toMatchObject({ sessionProbeError: 'box_read_timeout', forceReleaseWithheld: 'LOCK_WITHIN_GRACE_PERIOD' })
  expect(seen.slow!.lockAgeMs).toBeLessThan(BOUND)
}, 20_000)
