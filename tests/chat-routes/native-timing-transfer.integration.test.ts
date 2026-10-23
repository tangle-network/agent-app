import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { Sandbox } from '@tangle-network/sandbox'
import { observeNativeCompletion } from '../../src/chat-routes/native-completion'
import { createChatTurnRoutes, type NativeTurnTimingFacts } from '../../src/chat-routes/index'
import { createChatTables } from '../../src/chat-store/schema'
import { createChatStore, type ChatDatabase } from '../../src/chat-store/store'
import { createChatTurnOwnership } from '../../src/chat-routes/turn-ownership'
import { createNativeTimingTransfer } from '../../src/chat-routes/native-turn-timing'
import { createAssistantDraftWriter } from '../../src/chat-routes/draft-persistence'
import { createBufferedTurnTap, createMemoryTurnEventStore } from '../../src/stream/index'
import { createD1TurnTimingStore, ROLLOUT_TURN_TIMING_SCHEMA_SQL } from '../../src/rollout/d1'
import { runNativeCompletionWorkflow } from '../../src/preset-cloudflare/native-completion-workflow'
import type { CloudflareWorkflowStepLike } from '../../src/preset-cloudflare/detached-turn-workflow'
import type { NativeCompletionObservation, NativeCompletionReceipt } from '../../src/chat-routes/native-completion'
import { noteMeasuredTurnFacts } from '../../src/turn-trace/turn-facts'
import { openDatabase } from '../teams/db-helper'

function timingStore(sqlite: Database.Database, readObservedFacts?: Parameters<typeof createD1TurnTimingStore>[0]['readObservedFacts']) {
  return createD1TurnTimingStore({ measuredFacts: false, readObservedFacts, db: { prepare: sql => ({ bind: (...values) => ({
    run: async () => sqlite.prepare(sql).run(...values),
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values) as T[] }),
  }) }) } })
}

/** Real SQL checkpoint storage across owner reconstruction, implementing the documented Workflow step port. */
function durableSteps(sqlite: Database.Database): CloudflareWorkflowStepLike {
  return {
    async do<T>(name: string, callback: (context: unknown) => Promise<T>) {
      const saved = sqlite.prepare('SELECT value FROM checkpoints WHERE name = ?').get(name) as { value: string } | undefined
      if (saved) return JSON.parse(saved.value).value as T
      const value = await callback(undefined)
      sqlite.prepare('INSERT INTO checkpoints VALUES (?, ?)').run(name, JSON.stringify({ value }))
      return value
    },
    async sleep() { throw new Error('This exact-terminal fixture must not sleep') },
  }
}

it('transfers only observed facts over the actual route, preserves them across owner loss, and records the late Vault verdict once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-timing-'))
  const filename = join(directory, 'admission.sqlite')
  let sqlite = new Database(filename)
  sqlite.exec(`${ROLLOUT_TURN_TIMING_SCHEMA_SQL}
    CREATE TABLE admission (id TEXT PRIMARY KEY, timing_facts TEXT NOT NULL);
    CREATE TABLE checkpoints (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE effects (name TEXT PRIMARY KEY);
    CREATE TABLE transcript (id TEXT PRIMARY KEY, receipt TEXT NOT NULL);`)
  let streamId = ''
  let firstSnapshot: NativeTurnTimingFacts | undefined
  let releaseVisibility!: () => void
  const visibilityHeld = new Promise<void>(resolve => { releaseVisibility = resolve })
  let visibleObserved!: () => void
  let sawObserved = false
  const observed = new Promise<void>(resolve => { visibleObserved = () => { sawObserved = true; resolve() } })
  const receipt: NativeCompletionReceipt = { state: 'completed', text: 'Answer', parts: [], usage: {}, servedModel: 'actual-native-model', completedTurnIds: ['native-turn'] }
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost')
    const json = (value: unknown) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    if (url.pathname === '/v1/sandboxes/fixture-box') return json({ id: 'fixture-box', status: 'running',
      filesystemIncarnationId: 'fixture-incarnation', filesystemIncarnationProvenance: 'fresh', filesystemIncarnationReadiness: 'ready' })
    const path = url.pathname.replace('/v1/sandboxes/fixture-box/runtime', '')
    if (path === '/agents/sessions/session') return json({ id: 'session', status: 'completed', latestExecutionId: 'native-turn' })
    if (path === '/agents/sessions/session/runs') return json({ success: true, executions: [{
      executionId: 'native-turn', sessionId: 'session', status: 'completed', startedAt: 1, completedAt: 2, eventCount: 1, lastEventId: '1',
    }] })
    if (path === '/messages/turns') return json({ turnId: 'native-turn', sessionId: 'session', completedAt: new Date().toISOString(),
      result: { text: receipt.text, servedModel: receipt.servedModel, success: true } })
    if (path === '/messages') return json([])
    response.writeHead(200, { 'content-type': 'application/x-ndjson' })
    setTimeout(() => {
      response.write(`${JSON.stringify({ type: 'reasoning', text: 'Considering' })}\n`)
      setTimeout(() => response.end(`${JSON.stringify({ type: 'text', text: 'Answer' })}\n`), 20)
    }, 25)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const tables = createChatTables()
  const chatDb = openDatabase([tables.threads, tables.messages])
  const chatStore = createChatStore(chatDb as unknown as ChatDatabase, tables)
  await chatStore.createThread({ id: 'thread', workspaceId: 'workspace' })
  const pending: Promise<unknown>[] = []
  const routes = createChatTurnRoutes({
    projectId: 'native-timing-transfer', store: chatStore, turnStore: createMemoryTurnEventStore(), incrementalPersistence: false,
    turnTrace: false, log: () => {},
    authorize: async () => ({ ok: true as const, tenantId: 'workspace', userId: 'member', context: {} }),
    async produce(args) {
      streamId = args.turnStreamId
      expect(args.timingFacts, 'the actual assembled route supplies the serializable timing snapshot').toBeTypeOf('function')
      firstSnapshot = args.timingFacts!()
      expect(firstSnapshot.firstVisibleMs).toBeUndefined()
      // Registration precedes handoff/native dispatch, using the existing admission owner.
      sqlite.prepare('INSERT INTO admission VALUES (?, ?)').run(streamId, JSON.stringify(firstSnapshot))
      await args.handoffCompletion!({ async persistTimingFacts(facts) {
        if (facts.firstVisibleMs !== undefined) { visibleObserved(); await visibilityHeld }
        sqlite.prepare('UPDATE admission SET timing_facts = ? WHERE id = ?').run(JSON.stringify(facts), facts.turnStreamId)
        // Admission has committed, but this late projection fails after the Workflow timing checkpoint.
        if (facts.firstVisibleMs !== undefined) {
          sqlite.pragma('query_only = ON')
          try { await timingStore(sqlite).recordFacts(facts) } finally { sqlite.pragma('query_only = OFF') }
        } else await timingStore(sqlite).recordFacts(facts)
      } })
      return {
        stream: (async function* () {
          const response = await fetch(`${baseUrl}/events`)
          const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
          let buffer = ''
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            buffer += next.value
            while (buffer.includes('\n')) {
              const end = buffer.indexOf('\n')
              yield JSON.parse(buffer.slice(0, end))
              buffer = buffer.slice(end + 1)
            }
          }
        })(), finalText: () => 'Answer',
      }
    },
  })
  try {
    const response = await routes.turn(new Request('http://app.test/chat', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: 'thread', content: 'Continue' }) }),
    { waitUntil: promise => { pending.push(promise) } })
    const body = response.text()
    await Promise.race([observed, body.then(() => { expect(sawObserved, 'the actual route must persist its first visible observation').toBe(true) })])
    const initial = JSON.parse((sqlite.prepare('SELECT timing_facts FROM admission').get() as { timing_facts: string }).timing_facts) as NativeTurnTimingFacts
    expect(initial.firstVisibleMs).toBeUndefined()
    expect(sqlite.prepare('SELECT count(*) AS n FROM rollout_turn_timing').get()).toEqual({ n: 0 })
    // Close the request's durable connection and reconstruct the completion owner from disk.
    sqlite.close()
    sqlite = new Database(filename)
    noteMeasuredTurnFacts(streamId, { admissionMs: 99999, firstVisibleMs: 99999, model: 'wrong-isolate-model' })
    const payload = { sessionId: 'session', turnId: 'native-turn', registeredAt: Date.now() }
    const box = await new Sandbox({ apiKey: 'local-fixture', baseUrl }).get('fixture-box')
    if (!box) throw new Error('Fixture box missing')
    const run = () => runNativeCompletionWorkflow({ event: { payload }, step: durableSteps(sqlite),
      observe: () => observeNativeCompletion({ source: box, executionId: 'native-turn', sessionId: 'session', turnId: 'native-turn',
        registeredAt: payload.registeredAt, admissionStore: {
          async read() {
            const row = sqlite.prepare('SELECT id FROM admission WHERE id = ?').get(streamId)
            return row ? { executionId: 'native-turn', state: 'closed' as const, admittedTurnIds: ['native-turn'], ownerLeaseUntil: 0 } : null
          },
          async renew() { throw new Error('Closed admission must not renew') },
          async closeExpired() { throw new Error('Closed admission must not close again') },
        } }),
      async persistTranscript(_payload, final) {
        sqlite.prepare('INSERT INTO transcript VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET receipt = excluded.receipt').run(streamId, JSON.stringify(final))
        return streamId
      },
      async settle(_payload, final) {
        sqlite.prepare("INSERT OR IGNORE INTO effects VALUES ('vault-reconciled')").run()
        return { ...final, state: 'failed' as const, error: 'caller_unadmitted' }
      },
      async recordTiming(_payload, final, { settledAt }) {
        expect(sqlite.prepare("SELECT name FROM effects WHERE name = 'vault-reconciled'").get()).toBeDefined()
        const durable = JSON.parse((sqlite.prepare('SELECT timing_facts FROM admission WHERE id = ?').get(streamId) as { timing_facts: string }).timing_facts) as NativeTurnTimingFacts
        await timingStore(sqlite).record({ turnId: streamId, rollout: 'r', workspaceId: 'workspace', lane: 'sandbox',
          requestReceivedAt: durable.requestReceivedAt, admissionMs: durable.admissionMs, firstVisibleMs: durable.firstVisibleMs, firstTextMs: durable.firstTextMs,
          model: final.servedModel, settledMs: settledAt - durable.lifecycleStartedAt!, failed: final.state === 'failed', failureCode: final.error,
        }, { throwOnError: true })
        const latest = JSON.parse((sqlite.prepare('SELECT timing_facts FROM admission WHERE id = ?').get(streamId) as { timing_facts: string }).timing_facts) as NativeTurnTimingFacts
        await timingStore(sqlite).recordFacts(latest)
        sqlite.prepare("INSERT INTO effects VALUES ('timing-recorded')").run()
      },
      async releaseLock() { sqlite.prepare("INSERT OR IGNORE INTO effects VALUES ('released')").run() },
    })
    expect((await run()).state).toBe('failed')
    expect(sqlite.prepare('SELECT first_visible_ms, first_text_ms FROM rollout_turn_timing').get())
      .toEqual({ first_visible_ms: null, first_text_ms: null })
    releaseVisibility()
    expect(await body).toContain('Answer')
    await Promise.all(pending)
    const facts = JSON.parse((sqlite.prepare('SELECT timing_facts FROM admission').get() as { timing_facts: string }).timing_facts) as NativeTurnTimingFacts
    expect(facts.requestReceivedAt).toBe(firstSnapshot!.requestReceivedAt)
    expect(facts.lifecycleStartedAt! - facts.requestReceivedAt).toBe(facts.admissionMs)
    expect(facts.firstVisibleMs).toBeGreaterThanOrEqual(20)
    expect(facts.firstTextMs).toBeGreaterThanOrEqual(facts.firstVisibleMs!)
    expect((await run()).state).toBe('failed')
    expect(sqlite.prepare('SELECT count(*) AS n FROM rollout_turn_timing').get()).toEqual({ n: 1 })
    expect(sqlite.prepare('SELECT admission_ms, first_visible_ms, model, failed, failure_code FROM rollout_turn_timing').get())
      .toEqual({ admission_ms: facts.admissionMs, first_visible_ms: null, model: 'actual-native-model', failed: 1, failure_code: 'caller_unadmitted' })
    expect(sqlite.prepare("SELECT count(*) AS n FROM effects WHERE name = 'timing-recorded'").get()).toEqual({ n: 1 })
    const recovered = timingStore(sqlite, async turns => turns.flatMap(turn => {
      const row = sqlite.prepare('SELECT timing_facts FROM admission WHERE id = ?').get(turn.turnStreamId) as { timing_facts: string } | undefined
      return row ? [JSON.parse(row.timing_facts) as NativeTurnTimingFacts] : []
    }))
    const writesBefore = sqlite.prepare('SELECT total_changes() AS n').get()
    expect(await recovered.measureRequestOrigin({ rollout: 'r', since: 0 }))
      .toMatchObject({ samples: 1, failed: 1, requestOriginFirstVisibleP50Ms: facts.admissionMs! + facts.firstVisibleMs!,
        observedFacts: { requested: 1, matched: 1, observationReadFailed: false, unknown: 0 } })
    expect(sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(writesBefore)
    const unreadable = timingStore(sqlite, async () => { sqlite.prepare('SELECT missing_column FROM admission').all(); return [] })
    expect(await unreadable.measureRequestOrigin({ rollout: 'r', since: 0 }))
      .toMatchObject({ samples: 1, failed: 1, requestOriginFirstVisibleP50Ms: null,
        observedFacts: { requested: 1, matched: 0, observationReadFailed: true, unknown: 1 } })
  } finally {
    releaseVisibility()
    sqlite.close(); chatDb.$client.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})

it('keeps missing facts unknown, distinguishes raw failures from missing words, and retries a real SQLite write refusal', async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(ROLLOUT_TURN_TIMING_SCHEMA_SQL)
  const store = timingStore(sqlite)
  try {
    await store.record({ turnId: 'known', rollout: 'r', workspaceId: 'w', lane: 'sandbox', admissionMs: 100,
      firstVisibleMs: 200, firstTextMs: 300, settledMs: 400, failed: false, model: 'actual', at: 10 })
    await store.record({ turnId: 'unknown', rollout: 'r', workspaceId: 'w', lane: 'sandbox', settledMs: 500, failed: false, at: 20 })
    const measured = await store.measureRequestOrigin({ rollout: 'r', lane: 'sandbox', since: 0, until: 30 })
    expect(measured).toMatchObject({ samples: 2, failed: 0, failureRate: 0, requestOriginFirstVisibleP50Ms: 300,
      coverage: { admission: 1, firstVisible: 1, firstText: 1, requestOriginFirstVisible: 1, model: 1 }, truncated: false })
    const stage = await store.measureStage({ rollout: 'r', lane: 'sandbox', since: 0, stage: { name: 'all', value: '*', minSamples: 1, kill: {} } })
    expect(stage.metrics.first_visible_p50_ms).toBe(200)
    expect(stage.metrics.failure_rate).toBe(0.5)
    sqlite.pragma('query_only = ON')
    await expect(store.record({ turnId: 'refused', rollout: 'r', workspaceId: 'w', lane: 'sandbox', settledMs: 1, failed: false }, { throwOnError: true })).rejects.toThrow()
    sqlite.pragma('query_only = OFF')
    await store.record({ turnId: 'refused', rollout: 'r', workspaceId: 'w', lane: 'sandbox', settledMs: 1, failed: false }, { throwOnError: true })
    expect(sqlite.prepare("SELECT count(*) AS n FROM rollout_turn_timing WHERE turn_id = 'refused'").get()).toEqual({ n: 1 })
  } finally { sqlite.close() }
})

it('an observation HTTP 403 never records or releases a native terminal', async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec('CREATE TABLE checkpoints (name TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE effects (name TEXT PRIMARY KEY);')
  const server = createServer((_request, response) => response.writeHead(403).end('observer forbidden'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    await expect(runNativeCompletionWorkflow({
      event: { payload: { turnId: 't', sessionId: 's', registeredAt: Date.now() } }, step: durableSteps(sqlite),
      async observe(): Promise<NativeCompletionObservation> { const response = await fetch(url); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() },
      async persistTranscript() { throw new Error('No terminal proof') },
      async settle() { throw new Error('No terminal proof') },
      async recordTiming() { sqlite.prepare("INSERT INTO effects VALUES ('recorded')").run() },
      async releaseLock() { sqlite.prepare("INSERT INTO effects VALUES ('released')").run() },
    })).rejects.toThrow('HTTP 403')
    expect(sqlite.prepare('SELECT count(*) AS n FROM effects').get()).toEqual({ n: 0 })
  } finally {
    sqlite.close(); server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

it('guards late facts by exact origin, preserves the first observation and terminal verdict, and rejects invented durations', async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(ROLLOUT_TURN_TIMING_SCHEMA_SQL)
  const store = timingStore(sqlite)
  try {
    const facts = { turnStreamId: 'stream', requestReceivedAt: 1000, lifecycleStartedAt: 1100, admissionMs: 100, firstVisibleMs: 200, firstTextMs: 300 }
    // A fact write that races before terminal insertion cannot create a terminal.
    await store.recordFacts(facts)
    expect(sqlite.prepare('SELECT count(*) AS n FROM rollout_turn_timing').get()).toEqual({ n: 0 })
    await store.record({ turnId: 'stream', requestReceivedAt: 1000, rollout: 'r', workspaceId: 'w', lane: 'sandbox',
      revision: 'original', settledMs: 500, failed: true, failureCode: 'caller_unadmitted', at: 1600 })
    await store.recordFacts({ ...facts, requestReceivedAt: 999, lifecycleStartedAt: 1099 })
    await store.recordFacts({ ...facts, turnStreamId: 'foreign' })
    expect(sqlite.prepare('SELECT first_visible_ms FROM rollout_turn_timing').get()).toEqual({ first_visible_ms: null })
    await expect(store.recordFacts({ ...facts, firstVisibleMs: Number.NaN })).rejects.toThrow('finite nonnegative')
    await expect(store.recordFacts({ ...facts, firstTextMs: -1 })).rejects.toThrow('finite nonnegative')
    await expect(store.recordFacts({ ...facts, firstVisibleMs: undefined })).rejects.toThrow('first text requires')
    await expect(store.recordFacts({ ...facts, lifecycleStartedAt: 1200 })).rejects.toThrow('conflicting')
    await store.recordFacts(facts)
    await store.recordFacts({ ...facts, firstVisibleMs: 999, firstTextMs: 999 })
    expect(sqlite.prepare('SELECT admission_ms, first_visible_ms, first_text_ms, failed, failure_code, revision, settled_ms, at FROM rollout_turn_timing').get())
      .toEqual({ admission_ms: 100, first_visible_ms: 200, first_text_ms: 300, failed: 1, failure_code: 'caller_unadmitted', revision: 'original', settled_ms: 500, at: 1600 })
  } finally { sqlite.close() }
})

it('retains durable terminal authority when timing persistence rejects after registration and never dispatches native work', async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec('CREATE TABLE effects (name TEXT PRIMARY KEY);')
  const tables = createChatTables()
  const chatDb = openDatabase([tables.threads, tables.messages])
  const store = createChatStore(chatDb as unknown as ChatDatabase, tables)
  await store.createThread({ id: 'thread', workspaceId: 'workspace' })
  const pending: Promise<unknown>[] = []
  const routes = createChatTurnRoutes({ projectId: 'handoff-write-refusal', store, turnStore: createMemoryTurnEventStore(),
    incrementalPersistence: false, turnTrace: false, log: () => {},
    authorize: async () => ({ ok: true as const, tenantId: 'workspace', userId: 'member', context: {} }),
    async produce(args) {
      sqlite.prepare("INSERT INTO effects VALUES ('durable-owner-registered')").run()
      await args.handoffCompletion!({ async persistTimingFacts() {
        sqlite.pragma('query_only = ON')
        try { sqlite.prepare("INSERT INTO effects VALUES ('timing')").run() } finally { sqlite.pragma('query_only = OFF') }
      } })
      sqlite.prepare("INSERT INTO effects VALUES ('native-dispatched')").run()
      return { stream: (async function* () {})(), finalText: () => '' }
    },
    lifecycle: {
      async onTurnError() { sqlite.prepare("INSERT INTO effects VALUES ('route-error-settled')").run() },
      async onTurnComplete() { sqlite.prepare("INSERT INTO effects VALUES ('route-success-settled')").run() },
    },
  })
  try {
    const response = await routes.turn(new Request('http://app.test/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread', content: 'Continue' }) }), { waitUntil: promise => { pending.push(promise) } })
    await response.text().catch(() => '')
    await Promise.allSettled(pending)
    expect(sqlite.prepare('SELECT name FROM effects ORDER BY name').all()).toEqual([{ name: 'durable-owner-registered' }])
  } finally { sqlite.close(); chatDb.$client.close() }
})

it('measures one all-lane population without merging percentiles and keeps revision selection and unknown coverage explicit', async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(ROLLOUT_TURN_TIMING_SCHEMA_SQL)
  const store = timingStore(sqlite)
  try {
    for (const row of [
      { turnId: 'a', lane: 'sandbox', revision: 'original', admissionMs: 10, firstVisibleMs: 1000 },
      { turnId: 'b', lane: 'sandbox', revision: 'original', admissionMs: 10, firstVisibleMs: 2000 },
      { turnId: 'c', lane: 'loop', revision: undefined, admissionMs: 10, firstVisibleMs: 100 },
    ]) await store.record({ ...row, rollout: 'r', workspaceId: 'w', settledMs: 3000, failed: false, at: 10 })
    const all = await store.measureRequestOrigin({ rollout: 'r', since: 0, until: 20 })
    expect(all).toMatchObject({ samples: 3, requestOriginFirstVisibleP50Ms: 1010,
      coverage: { revision: 2, model: 0, requestOriginFirstVisible: 3 }, selection: { lane: null, revision: 'all' } })
    expect(await store.measureRequestOrigin({ rollout: 'r', lane: 'sandbox', revision: 'original', since: 0, until: 20 }))
      .toMatchObject({ samples: 2, requestOriginFirstVisibleP50Ms: 1010, selection: { lane: 'sandbox', revision: 'original' } })
    expect(await store.measureRequestOrigin({ rollout: 'r', revision: null, since: 0, until: 20 }))
      .toMatchObject({ samples: 1, requestOriginFirstVisibleP50Ms: 110, coverage: { revision: 0 }, selection: { revision: null } })
    expect(await store.measureRequestOrigin({ rollout: 'r', since: 20, until: 30 }))
      .toMatchObject({ samples: 0, failed: 0, failureRate: null, requestOriginFirstVisibleP50Ms: null })
  } finally { sqlite.close() }
})

it('quiesces the real draft writer and buffer renewal even when the registered owner timing callback refuses', async () => {
  const tables = createChatTables()
  const db = openDatabase([tables.threads, tables.messages])
  const store = createChatStore(db as unknown as ChatDatabase, tables)
  await store.createThread({ id: 'thread', workspaceId: 'workspace' })
  db.$client.exec('CREATE TABLE admission (id TEXT PRIMARY KEY);')
  const events = createMemoryTurnEventStore({ runningTurnLeaseMs: 30 })
  const tap = createBufferedTurnTap({ turnId: 'stream', scopeId: 'thread', store: events, runningTurnRenewIntervalMs: 10 })
  let content = 'Initial draft'
  const draft = createAssistantDraftWriter({ store, threadId: 'thread', messageId: 'assistant:stream', intervalMs: 0,
    snapshot: () => ({ content }) })
  const origin = Date.now()
  const state = { completionHandoff: false, completionHandoffPromise: undefined,
    nativeTiming: createNativeTimingTransfer(() => ({ turnStreamId: 'stream', requestReceivedAt: origin, lifecycleStartedAt: origin, admissionMs: 0 }), () => {}),
    tap, draft, lockAcquired: false, lockReleased: false, lockHandle: undefined }
  try {
    await tap.onEvent({ type: 'turn', turnId: 'stream' })
    draft.notify({ type: 'text' })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect((await store.listMessages('thread'))[0]?.content).toBe('Initial draft')
    db.$client.prepare('INSERT INTO admission VALUES (?)').run('registered-owner')
    const owner = createChatTurnOwnership(state, () => {}, 'stream', {})
    await expect(owner.handoffCompletion({ async persistTimingFacts() {
      db.$client.pragma('query_only = ON')
      try { db.$client.prepare('INSERT INTO admission VALUES (?)').run('timing') } finally { db.$client.pragma('query_only = OFF') }
    } })).rejects.toThrow()
    expect(state.completionHandoff).toBe(true)
    content = 'A stale projector must never overwrite the durable owner'
    draft.notify({ type: 'text' })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect((await store.listMessages('thread'))[0]?.content).toBe('Initial draft')
    expect(await events.listRunning!('thread')).toEqual([])
    expect(db.$client.prepare('SELECT id FROM admission').all()).toEqual([{ id: 'registered-owner' }])
  } finally { await tap.detach(); await draft.close(); db.$client.close() }
})
