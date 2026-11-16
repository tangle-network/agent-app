import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Sandbox } from '@tangle-network/sandbox'
import { expect, it } from 'vitest'
import { readHolderBoxSessions } from '../../src/sandbox/holder-box'
import { createD1TurnEventStore, TURN_EVENTS_MIGRATION_SQL } from '../../src/stream/index'
import { acquireDurableTurnLock, createDurableTurnLock, parkDurableTurnLock } from '../../src/turn-stream/index'
import { createMemoryTurnStreamHarness, MEMORY_TURN_STREAM_AUTH_SECRET } from '../../src/turn-stream/memory'
import { sqliteD1 } from '../launch-invariants/sqlite-d1'

/**
 * Incident 3 (2026-11-16): a turn's invocation was cancelled, its lock release never ran, and every turn in the
 * workspace was refused for the lock's 30 minute TTL. The authenticated TurnStreamDO core, a migrated SQLite D1 turn
 * store, the public Sandbox SDK over loopback HTTP and the shipped lock adapter with no product reconcile. No SDK
 * method, store or clock is replaced. Past the 60 s terminal grace: a dead holder with no box work is reclaimed; a box
 * with an active execution holds; a box whose sessions are finished (one returned without a status, which the SDK reads
 * as running) is reclaimed; a box API answering 503 is reclaimed at the unreachable bound; a renewed running row and a
 * parked release hold.
 */
it('reclaims a dead holder by default and holds while its box or turn still runs', async () => {
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://peer').pathname
    const json = (code: number, value: unknown) => response.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    const box = /^\/v1\/sandboxes\/([a-z]+)-box(\/runtime\/agents\/sessions)?$/.exec(path)
    if (!box) return json(404, { error: `unexpected ${request.method} ${path}` })
    const [, name, sessions] = box
    if (name === 'down') return json(503, { error: 'sandbox api unavailable' })
    if (!sessions) return json(200, { id: `${name}-box`, status: 'running', filesystemIncarnationId: `${name}-incarnation`,
      filesystemIncarnationProvenance: 'fresh', filesystemIncarnationReadiness: 'ready',
      connection: { runtimeUrl: `${origin}/v1/sandboxes/${name}-box/runtime` } })
    // The sidecar's own verdict (hasActiveExecution) decides; a finished session can keep a stale activeExecutionId,
    // and one with no status is read as running by the SDK. Neither is live work.
    return json(200, name === 'busy'
      ? [{ id: 'detached-run', status: 'running', activeExecutionId: 'detached-execution', hasActiveExecution: true }]
      : [{ id: 'detached-run', status: 'completed', latestExecutionId: 'detached-execution', hasActiveExecution: false },
        { id: 'stale-run', status: 'completed', activeExecutionId: 'stale-execution', hasActiveExecution: false },
        { id: 'earlier-run', latestExecutionId: 'earlier' }])
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const client = new Sandbox({ apiKey: 'local-fixture', baseUrl: origin })
    const turns = createD1TurnEventStore(sqliteD1(TURN_EVENTS_MIGRATION_SQL).d1)
    const durable = createMemoryTurnStreamHarness()
    const auth = { secret: MEMORY_TURN_STREAM_AUTH_SECRET }
    const boxOf: Record<string, string> = { busy: 'busy-box', finished: 'finished-box', down: 'down-box' }
    const lock = createDurableTurnLock<Record<string, never>>({ namespace: durable.namespace, auth, scopeOf: () => 'workspace',
      turnStore: turns, unreachableGraceMs: 90_000,
      readHolderBox: active => readHolderBoxSessions(async () => boxOf[active.workspaceId] ? client.get(boxOf[active.workspaceId]!) : null) })
    const hold = async (workspaceId: string) => {
      const held = await acquireDurableTurnLock(durable.namespace, { workspaceId, threadId: `${workspaceId}-earlier`, scope: 'workspace',
        executionId: crypto.randomUUID() }, auth)
      if (!held.acquired) throw new Error(`${workspaceId}: the holder could not take the lock`)
      return held.lock
    }
    const seen: Record<string, Record<string, unknown>> = {}
    const ask = async (workspaceId: string) => {
      const result = await lock.acquire({ identity: { tenantId: workspaceId, sessionId: `${workspaceId}-new` },
        executionId: crypto.randomUUID(), context: {}, body: {} })
      if (result.acquired) return 'acquired'
      const body = (await result.response.json()) as { error: { code: string; diagnostics?: Record<string, unknown> } }
      seen[workspaceId] = body.error.diagnostics ?? {}
      return `${result.response.status} ${body.error.code}`
    }

    for (const workspaceId of ['dead', 'busy', 'finished', 'down', 'live']) await hold(workspaceId)
    await turns.setStatus('live-turn', 'running', 'live-earlier')
    const parked = await hold('parked')
    expect(await parkDurableTurnLock(durable.namespace, { workspaceId: 'parked', threadId: 'parked-earlier', scope: 'workspace',
      executionId: parked.executionId, lockId: parked.lockId }, auth)).toBe(true)

    expect(await ask('dead')).toBe('409 workspace_turn_in_flight') // inside the terminal grace
    await new Promise(resolve => setTimeout(resolve, 61_000))
    expect(await ask('dead')).toBe('acquired')
    expect(await ask('busy')).toBe('409 workspace_turn_in_flight')
    expect(seen.busy).toMatchObject({ liveBoxSessions: 1, boxSessions: 1 })
    expect(await ask('finished')).toBe('acquired')
    // A box that does not answer is unreachable: held inside its own (distinct) bound, released after it.
    expect(await ask('down')).toBe('409 workspace_turn_in_flight')
    expect(String(seen.down?.sessionProbeError)).toMatch(/^box_(unreachable|read_timeout)$/)
    expect(JSON.stringify(seen.down)).not.toMatch(/503|unavailable/)
    expect(await ask('live')).toBe('409 workspace_turn_in_flight')
    expect(seen.live).toMatchObject({ runningTurns: 1 })
    expect(await ask('parked')).toBe('409 workspace_turn_in_flight')
    expect(seen.parked).toMatchObject({ releasePending: true })
    await new Promise(resolve => setTimeout(resolve, 30_000))
    expect(await ask('down')).toBe('acquired')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}, 150_000)
