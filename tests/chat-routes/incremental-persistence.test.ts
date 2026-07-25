/**
 * Incremental assistant persistence, proven against the REAL durable store —
 * `createChatTables` + `createChatStore` over better-sqlite3, the same drizzle
 * path a product runs on D1 — driven through the real `createChatTurnRoutes`
 * assembly and the real `createSandboxChatProducer` normalizers. No store fake:
 * every assertion below reads rows back out of SQLite.
 *
 * The four claims that matter:
 *  1. the durable row EXISTS and GROWS while the turn is still streaming
 *     (queried mid-run, from inside the producer),
 *  2. the row a drafted turn ends with is byte-identical to the row the
 *     single-write path produces for the same events,
 *  3. a crashed turn re-entered converges onto the SAME row with no duplicated
 *     parts, in both the interactive and the autonomous lane,
 *  4. writes are coalesced — a token-per-write implementation fails this.
 */

import { describe, expect, it } from 'vitest'

import {
  createChatTurnRoutes,
  createSandboxChatProducer,
  runDetachedTurn,
  type ChatTurnMessageStore,
} from '../../src/chat-routes/index'
import { createChatStore, type ChatDatabase } from '../../src/chat-store/store'
import { createChatTables } from '../../src/chat-store/schema'
import type { ChatMessagePart } from '../../src/chat-store/parts'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { openDatabase, workspacesTable } from '../teams/db-helper'

const tables = createChatTables({ workspaceTable: workspacesTable })

async function freshStore() {
  const db = openDatabase([workspacesTable, tables.threads, tables.messages]) as unknown as ChatDatabase
  await db.insert(workspacesTable).values([{ id: 'ws1', organizationId: 'org1', name: 'WS 1' }])
  const store = createChatStore(db, tables)
  const thread = await store.createThread({ workspaceId: 'ws1', title: 'T' })
  return { db, store, threadId: thread.id }
}

type Row = { id: string; role: string; content: string; parts: ChatMessagePart[] | null; model: string | null; inputTokens: number | null; outputTokens: number | null; costUsd: number | null }

async function rows(store: Awaited<ReturnType<typeof freshStore>>['store'], threadId: string): Promise<Row[]> {
  return (await store.listMessages(threadId)) as unknown as Row[]
}

async function assistantRow(store: Awaited<ReturnType<typeof freshStore>>['store'], threadId: string): Promise<Row | undefined> {
  return (await rows(store, threadId)).find((row) => row.role === 'assistant')
}

/** Poll until `predicate` holds — the draft write is fire-and-forget by design
 *  (the stream must never block on store latency), so a mid-run reader waits
 *  for it rather than assuming a synchronous write. */
async function waitUntil<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`waitUntil timed out: ${label}`)
}

function partUpdated(part: Record<string, unknown>, delta?: string): Record<string, unknown> {
  return { type: 'message.part.updated', data: { part, ...(delta !== undefined ? { delta } : {}) } }
}

/** One canonical turn: text, a tool that runs then completes, more text, a
 *  usage receipt, a result. The exact vocabulary the sidecar emits. */
const TURN_EVENTS: Array<Record<string, unknown>> = [
  partUpdated({ type: 'text', id: 'txt1', text: 'Checking ' }, 'Checking '),
  partUpdated({ type: 'tool', id: 'call-1', tool: 'vault_search', state: { status: 'running', input: { query: 'lease' } } }),
  partUpdated({ type: 'tool', id: 'call-1', tool: 'vault_search', state: { status: 'completed', input: { query: 'lease' }, output: { hits: 2 } } }),
  partUpdated({ type: 'text', id: 'txt1', text: 'Checking the lease. Found 2.' }, 'the lease. Found 2.'),
  partUpdated({ type: 'step-finish', reason: 'stop', tokens: { input: 40, output: 20, reasoning: 5, cache: { read: 10, write: 2 } }, cost: 0.0123 }),
  { type: 'result', data: { finalText: 'Checking the lease. Found 2.' } },
]

function turnRequest(threadId: string, content: string, extra: Record<string, unknown> = {}): Request {
  return new Request('http://app.test/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, content, ...extra }),
  })
}

function routesOver(
  store: ChatTurnMessageStore,
  produce: () => ReturnType<typeof createSandboxChatProducer>,
  overrides: Record<string, unknown> = {},
) {
  const turnStore = createMemoryTurnEventStore()
  const pending: Promise<unknown>[] = []
  const routes = createChatTurnRoutes({
    projectId: 'incremental-test',
    authorize: async () => ({ ok: true, tenantId: 'ws1', userId: 'u1', context: undefined }),
    store,
    turnStore,
    produce,
    log: () => {},
    ...overrides,
  })
  return { routes, turnStore, ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) }, settle: () => Promise.all(pending) }
}

async function drain(res: Response): Promise<void> {
  await new Response(res.body!).text()
}

// ── 1. the row exists and grows mid-run ─────────────────────────────────────

describe('incremental assistant persistence — mid-run durability', () => {
  it('writes the assistant row WHILE the turn streams, growing it, with in-flight tools left running', async () => {
    const { store, threadId } = await freshStore()
    const samples: Array<{ content: string; parts: ChatMessagePart[] }> = []

    // The producer's own stream is the mid-run probe: between yields it reads
    // the DURABLE store, exactly as a late viewer's page load would.
    async function* events(): AsyncGenerator<unknown> {
      yield TURN_EVENTS[0]
      const afterText = await waitUntil(
        () => assistantRow(store, threadId),
        (row) => Boolean(row && row.content.length > 0),
        'assistant row after first text',
      )
      samples.push({ content: afterText!.content, parts: afterText!.parts ?? [] })

      yield TURN_EVENTS[1]
      const withRunningTool = await waitUntil(
        () => assistantRow(store, threadId),
        (row) => (row?.parts ?? []).some((part) => part.type === 'tool'),
        'assistant row carrying the in-flight tool part',
      )
      samples.push({ content: withRunningTool!.content, parts: withRunningTool!.parts ?? [] })

      yield TURN_EVENTS[2]
      yield TURN_EVENTS[3]
      const afterMoreText = await waitUntil(
        () => assistantRow(store, threadId),
        (row) => (row?.content ?? '').includes('Found 2.'),
        'assistant row carrying the later text',
      )
      samples.push({ content: afterMoreText!.content, parts: afterMoreText!.parts ?? [] })

      yield TURN_EVENTS[4]
      yield TURN_EVENTS[5]
    }

    const { routes, ctx, settle } = routesOver(
      store as unknown as ChatTurnMessageStore,
      () => createSandboxChatProducer({ events: events(), model: 'anthropic/claude' }),
      // 0 ms floor keeps the probe deterministic; coalescing is proven below.
      { incrementalPersistence: { intervalMs: 0 } },
    )

    await drain(await routes.turn(turnRequest(threadId, 'find the lease'), ctx))
    await settle()

    // The durable row was READABLE mid-run, three times, and grew.
    expect(samples).toHaveLength(3)
    expect(samples[0]!.content).toBe('Checking ')
    expect(samples[2]!.content).toBe('Checking the lease. Found 2.')
    expect(samples[1]!.parts.length).toBeGreaterThan(samples[0]!.parts.length)

    // The non-obvious one: an IN-FLIGHT tool must persist as `running`, not as
    // the terminalized error `finalizeAssistantParts` stamps on a dangling tool.
    const midTool = samples[1]!.parts.find((part) => part.type === 'tool') as
      | { state?: { status?: string; metadata?: Record<string, unknown> } }
      | undefined
    expect(midTool?.state?.status).toBe('running')
    expect(midTool?.state?.metadata?.terminalized).toBeUndefined()

    // Exactly one assistant row survives the turn — drafts patched it, never
    // appended beside it.
    const all = await rows(store, threadId)
    expect(all.filter((row) => row.role === 'assistant')).toHaveLength(1)
  })

  it('the final row is byte-identical to the one the single-write path produces', async () => {
    async function runTurn(incremental: false | { intervalMs: number }) {
      const { store, threadId } = await freshStore()
      const { routes, ctx, settle } = routesOver(
        store as unknown as ChatTurnMessageStore,
        () => createSandboxChatProducer({ events: (async function* () { for (const e of TURN_EVENTS) yield e })(), model: 'anthropic/claude' }),
        { incrementalPersistence: incremental },
      )
      await drain(await routes.turn(turnRequest(threadId, 'find the lease'), ctx))
      await settle()
      const row = (await assistantRow(store, threadId))!
      // `id` and `createdAt` are the only fields allowed to differ (one is
      // deterministic, one is a clock).
      return {
        content: row.content,
        parts: JSON.stringify(row.parts),
        model: row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        costUsd: row.costUsd,
      }
    }

    const drafted = await runTurn({ intervalMs: 0 })
    const single = await runTurn(false)
    expect(drafted).toEqual(single)
    // And the completion-time settlement still ran: the tool is `completed`,
    // not left at whatever the last draft saw.
    const tool = (JSON.parse(drafted.parts) as Array<Record<string, any>>).find((p) => p.type === 'tool')
    expect(tool!.state.status).toBe('completed')
    expect(tool!.state.output).toEqual({ hits: 2 })
  })
})

// ── 2. coalescing ───────────────────────────────────────────────────────────

describe('incremental assistant persistence — write cadence', () => {
  it('coalesces: 200 token events produce a handful of writes, not 200', async () => {
    const { store, threadId } = await freshStore()
    let appends = 0
    let updates = 0
    const counting: ChatTurnMessageStore = {
      listMessages: (id) => store.listMessages(id) as never,
      appendMessage: (input) => { appends += 1; return store.appendMessage(input as never) },
      updateMessage: (id, patch) => { updates += 1; return store.updateMessage(id, patch as never) },
      deleteMessage: (id) => store.deleteMessage(id),
    }

    async function* events(): AsyncGenerator<unknown> {
      let text = ''
      for (let i = 0; i < 200; i += 1) {
        text += 'x'
        yield partUpdated({ type: 'text', id: 'txt1', text }, 'x')
      }
      yield { type: 'result', data: { finalText: text } }
    }

    const { routes, ctx, settle } = routesOver(
      counting,
      () => createSandboxChatProducer({ events: events(), model: 'm' }),
      // Default 2 s cadence: the whole 200-event burst lands inside one window.
      { incrementalPersistence: {} },
    )
    await drain(await routes.turn(turnRequest(threadId, 'stream me'), ctx))
    await settle()

    // 1 user append + 1 draft append. Everything after the first draft is a
    // patch, and the 2 s floor admits at most a couple of them.
    expect(appends).toBe(2)
    expect(updates).toBeLessThanOrEqual(3)
    const row = (await assistantRow(store, threadId))!
    expect(row.content).toBe('x'.repeat(200))
  })

  it('leaves NO row when the turn produces nothing, even after a draft started', async () => {
    const { store, threadId } = await freshStore()
    async function* events(): AsyncGenerator<unknown> {
      yield partUpdated({ type: 'text', id: 'txt1', text: 'partial' }, 'partial')
      // The harness retracts it: the final projection is empty.
      yield { type: 'result', data: { finalText: '' } }
    }
    const producer = createSandboxChatProducer({ events: events(), model: 'm' })
    const emptyingProducer = { ...producer, finalText: () => '', assistantParts: () => [] }

    const { routes, ctx, settle } = routesOver(
      store as unknown as ChatTurnMessageStore,
      () => emptyingProducer as ReturnType<typeof createSandboxChatProducer>,
      { incrementalPersistence: { intervalMs: 0 } },
    )
    await drain(await routes.turn(turnRequest(threadId, 'nothing'), ctx))
    await settle()

    expect((await rows(store, threadId)).filter((row) => row.role === 'assistant')).toHaveLength(0)
  })

  it('an errored turn still settles as FAILED and unbilled, with its partial answer kept as an error row', async () => {
    const { store, threadId } = await freshStore()
    const completions: Array<{ failed: boolean; failureReason?: string }> = []
    async function* events(): AsyncGenerator<unknown> {
      yield TURN_EVENTS[0]
      await waitUntil(
        () => assistantRow(store, threadId),
        (row) => Boolean(row && row.content.length > 0),
        'draft row before the failure',
      )
      // Terminal error EVENT (not a throw) — the 402 / rate-limit shape.
      yield { type: 'error', data: { message: 'model quota exhausted' } }
    }
    const { routes, ctx, settle } = routesOver(
      store as unknown as ChatTurnMessageStore,
      () => createSandboxChatProducer({ events: events(), model: 'm' }),
      {
        incrementalPersistence: { intervalMs: 0 },
        onTurnComplete: async (input: { failed: boolean; failureReason?: string }) => {
          completions.push({ failed: input.failed, failureReason: input.failureReason })
        },
      },
    )
    await drain(await routes.turn(turnRequest(threadId, 'ask'), ctx))
    await settle()

    // Billing branches on this, and drafting must not have changed it.
    expect(completions).toEqual([{ failed: true, failureReason: 'model quota exhausted' }])
    // The partial answer is kept as ONE row carrying the visible error text —
    // not a second row, and not an empty one.
    const assistants = (await rows(store, threadId)).filter((row) => row.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]!.content).toContain('Checking ')
    expect(assistants[0]!.content).toContain('model quota exhausted')
  })

  it('applies transformFinalText to DRAFT text and DRAFT text parts (the at-rest leak must not reopen mid-stream)', async () => {
    const { store, threadId } = await freshStore()
    // Sampled from INSIDE the stream — the final write re-redacts, so only a
    // mid-run read can catch an unredacted draft.
    let draftSnapshot: Row | undefined
    async function* events(): AsyncGenerator<unknown> {
      yield partUpdated({ type: 'text', id: 'txt1', text: 'SSN 123-45-6789 on file' }, 'SSN 123-45-6789 on file')
      draftSnapshot = await waitUntil(
        () => assistantRow(store, threadId),
        (row) => Boolean(row && row.content.length > 0),
        'draft row while streaming',
      )
      yield { type: 'result', data: { finalText: 'SSN 123-45-6789 on file' } }
    }
    const { routes, ctx, settle } = routesOver(
      store as unknown as ChatTurnMessageStore,
      () => createSandboxChatProducer({ events: events(), model: 'm' }),
      {
        incrementalPersistence: { intervalMs: 0 },
        transformFinalText: (text: string) => text.replace(/\d{3}-\d{2}-\d{4}/g, '[redacted]'),
      },
    )
    await drain(await routes.turn(turnRequest(threadId, 'file it'), ctx))
    await settle()

    expect(draftSnapshot).toBeDefined()
    expect(draftSnapshot!.content).toBe('SSN [redacted] on file')
    expect(JSON.stringify(draftSnapshot!.parts)).not.toContain('123-45-6789')
    const finalRow = (await assistantRow(store, threadId))!
    expect(finalRow.content).toBe('SSN [redacted] on file')
    expect(JSON.stringify(finalRow.parts)).not.toContain('123-45-6789')
  })
})

// ── 3. crash + re-entry convergence ─────────────────────────────────────────

describe('incremental assistant persistence — crash-safe convergence', () => {
  it('interactive lane: a crashed turn re-entered converges onto ONE row with no duplicated parts', async () => {
    const { store, threadId } = await freshStore()

    // Attempt 1: the worker dies mid-stream. Faithful simulation — the producer
    // hangs forever and the request promise is abandoned, so the drain never
    // runs, the turn buffer stays `running`, and the draft row is left partial.
    const hang = new Promise<never>(() => {})
    async function* crashing(): AsyncGenerator<unknown> {
      yield TURN_EVENTS[0]
      yield TURN_EVENTS[1]
      await hang
    }
    const first = routesOver(
      store as unknown as ChatTurnMessageStore,
      () => createSandboxChatProducer({ events: crashing(), model: 'anthropic/claude' }),
      { incrementalPersistence: { intervalMs: 0 } },
    )
    const firstRes = await first.routes.turn(turnRequest(threadId, 'find the lease'), first.ctx)
    void new Response(firstRes.body!).text().catch(() => {})
    const partial = await waitUntil(
      () => assistantRow(store, threadId),
      (row) => Boolean(row && row.content.length > 0),
      'partial row from the crashed attempt',
    )
    const partialRowId = partial!.id
    expect(partial!.content).toBe('Checking ')

    // Attempt 2: the durable driver / client retries the SAME turn against the
    // SAME turn store (its running index is what tells the retry apart from a
    // user genuinely repeating themselves).
    const second = routesOver(
      store as unknown as ChatTurnMessageStore,
      () => createSandboxChatProducer({ events: (async function* () { for (const e of TURN_EVENTS) yield e })(), model: 'anthropic/claude' }),
      { incrementalPersistence: { intervalMs: 0 }, turnStore: first.turnStore },
    )
    await drain(await second.routes.turn(turnRequest(threadId, 'find the lease'), second.ctx))
    await second.settle()

    const all = await rows(store, threadId)
    // Converged: one user row, one assistant row — and it is the SAME row the
    // crashed attempt started.
    expect(all.filter((row) => row.role === 'user')).toHaveLength(1)
    const assistants = all.filter((row) => row.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]!.id).toBe(partialRowId)
    expect(assistants[0]!.content).toBe('Checking the lease. Found 2.')
    // No duplicated parts: one text segment, one tool part — not two of each.
    const parts = assistants[0]!.parts ?? []
    expect(parts.filter((part) => part.type === 'text')).toHaveLength(1)
    expect(parts.filter((part) => part.type === 'tool')).toHaveLength(1)
  })

  it('a user genuinely repeating a message after a SETTLED turn still gets a new turn', async () => {
    const { store, threadId } = await freshStore()
    const shared = createMemoryTurnEventStore()
    async function run() {
      const { routes, ctx, settle } = routesOver(
        store as unknown as ChatTurnMessageStore,
        () => createSandboxChatProducer({ events: (async function* () { for (const e of TURN_EVENTS) yield e })(), model: 'm' }),
        { incrementalPersistence: { intervalMs: 0 }, turnStore: shared },
      )
      await drain(await routes.turn(turnRequest(threadId, 'same question'), ctx))
      await settle()
    }
    await run()
    await run()

    const all = await rows(store, threadId)
    expect(all.filter((row) => row.role === 'user')).toHaveLength(2)
    expect(all.filter((row) => row.role === 'assistant')).toHaveLength(2)
  })

  it('autonomous lane: runDetachedTurn owns the row, drafts it mid-run, and converges after a crash', async () => {
    const { store, threadId } = await freshStore()
    const turnStore = createMemoryTurnEventStore()
    // `createChatStore(...)` satisfies the draft-store contract directly — no cast.
    const persist = { store, threadId, intervalMs: 0 }

    // Attempt 1: the worker is killed mid-run — the call never returns, the
    // turn buffer is left `running`, the draft row is left partial.
    const hang = new Promise<never>(() => {})
    async function* crashing(): AsyncGenerator<unknown> {
      yield TURN_EVENTS[0]
      await hang
    }
    void runDetachedTurn({ store: turnStore, turnId: 'mission-step-7', scopeId: threadId, events: crashing(), model: 'm', persist }).catch(() => {})
    const partial = (await waitUntil(
      () => assistantRow(store, threadId),
      (row) => Boolean(row && row.content.length > 0),
      'partial row from the crashed detached attempt',
    ))!
    expect(partial.content).toBe('Checking ')
    expect(await turnStore.getStatus('mission-step-7')).toBe('running')

    // The durable driver re-invokes. `resetBuffer` clears the partial turn
    // buffer; the assistant ROW is addressed by the same deterministic id.
    const res = await runDetachedTurn({
      store: turnStore,
      turnId: 'mission-step-7',
      scopeId: threadId,
      events: (async function* () { for (const e of TURN_EVENTS) yield e })(),
      model: 'm',
      persist,
      resetBuffer: async () => {},
    })

    expect(res.state).toBe('completed')
    expect(res.messageId).toBe(partial.id)
    const assistants = (await rows(store, threadId)).filter((row) => row.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]!.id).toBe(partial.id)
    expect(assistants[0]!.content).toBe('Checking the lease. Found 2.')
    const parts = assistants[0]!.parts ?? []
    expect(parts.filter((part) => part.type === 'text')).toHaveLength(1)
    expect(parts.filter((part) => part.type === 'tool')).toHaveLength(1)
    expect(assistants[0]!.inputTokens).toBe(40)
  })

  // The autonomous lane's completion-time settlement, isolated. The crash test
  // above cannot see it: at `intervalMs: 0` over a turn whose tools all
  // complete, the last draft happens to equal the final projection, so dropping
  // the authoritative write would still leave a correct-looking row. This test
  // removes that coincidence — DEFAULT cadence (only the first draft escapes
  // the 2 s floor, so the last draft is stale) and a tool that never completes
  // (only `finalizeAssistantParts` terminalizes it; `draftParts` deliberately
  // leaves it `running`). Both differences are invisible unless the final write
  // is authoritative over the draft.
  it('autonomous lane: the FINAL write is authoritative over the last draft (stale cadence + dangling tool)', async () => {
    const { store, threadId } = await freshStore()
    let midRun: Row | undefined
    async function* events(): AsyncGenerator<unknown> {
      yield partUpdated({ type: 'text', id: 'txt1', text: 'Looking' }, 'Looking')
      // The one draft the default cadence admits — proving the row is created
      // by a DRAFT, so a lane that skipped the final write would leave this
      // stale row behind rather than no row at all.
      midRun = await waitUntil(
        () => assistantRow(store, threadId),
        (row) => Boolean(row && row.content.length > 0),
        'the single draft row the default cadence admits',
      )
      yield partUpdated({ type: 'tool', id: 'call-9', tool: 'vault_search', state: { status: 'running', input: { query: 'lease' } } })
      yield partUpdated({ type: 'text', id: 'txt1', text: 'Looking, then gave up.' }, ', then gave up.')
      yield { type: 'result', data: { finalText: 'Looking, then gave up.' } }
    }

    const res = await runDetachedTurn({
      store: createMemoryTurnEventStore(),
      turnId: 'mission-step-9',
      scopeId: threadId,
      events: events(),
      model: 'm',
      // No `intervalMs`: the shipped 2 s default, so later drafts are throttled.
      persist: { store, threadId },
    })

    expect(res.state).toBe('completed')
    expect(midRun!.content).toBe('Looking')

    const assistants = (await rows(store, threadId)).filter((row) => row.role === 'assistant')
    expect(assistants).toHaveLength(1)
    // Same row the draft started — patched, never appended beside.
    expect(assistants[0]!.id).toBe(midRun!.id)
    expect(res.messageId).toBe(midRun!.id)
    // Authoritative text: the stale draft's 'Looking' did not survive.
    expect(assistants[0]!.content).toBe('Looking, then gave up.')
    // Authoritative parts: the dangling tool is terminalized, which only the
    // completion-time projection does.
    const tool = (assistants[0]!.parts ?? []).find((part) => part.type === 'tool') as
      | { state?: { status?: string; metadata?: Record<string, unknown> } }
      | undefined
    expect(tool).toBeDefined()
    expect(tool!.state?.status).toBe('error')
    expect(tool!.state?.metadata?.terminalized).toBe(true)
  })

  it('autonomous lane without `persist` is byte-unchanged: no row is written at all', async () => {
    const { store, threadId } = await freshStore()
    const res = await runDetachedTurn({
      store: createMemoryTurnEventStore(),
      turnId: 't-1',
      scopeId: threadId,
      events: (async function* () { for (const e of TURN_EVENTS) yield e })(),
      model: 'm',
    })
    expect(res.state).toBe('completed')
    expect(res.messageId).toBeUndefined()
    expect(await rows(store, threadId)).toHaveLength(0)
  })
})

// ── 4. the additive guarantee ───────────────────────────────────────────────

describe('incremental assistant persistence — additive by construction', () => {
  it('a store without updateMessage keeps the single-write path, and an explicit opt-in fails loud', async () => {
    const rowsWritten: Array<Record<string, unknown>> = []
    const legacyStore: ChatTurnMessageStore = {
      async listMessages() { return [] },
      async appendMessage(input) { rowsWritten.push(input); return { id: `m${rowsWritten.length}` } },
    }
    const { routes, ctx, settle } = routesOver(
      legacyStore,
      () => createSandboxChatProducer({ events: (async function* () { for (const e of TURN_EVENTS) yield e })(), model: 'm' }),
    )
    await drain(await routes.turn(turnRequest('t-legacy', 'hello'), ctx))
    await settle()
    expect(rowsWritten).toHaveLength(2)
    expect(rowsWritten[1]).toMatchObject({ role: 'assistant', content: 'Checking the lease. Found 2.' })
    expect(rowsWritten[1]!.id).toBeUndefined()

    expect(() =>
      createChatTurnRoutes({
        projectId: 'p',
        authorize: async () => ({ ok: true, tenantId: 'w', userId: 'u', context: undefined }),
        store: legacyStore,
        turnStore: createMemoryTurnEventStore(),
        produce: () => createSandboxChatProducer({ events: (async function* () {})() }),
        incrementalPersistence: {},
      }),
    ).toThrow(/updateMessage/)
  })
})
