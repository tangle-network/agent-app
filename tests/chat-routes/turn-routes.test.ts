import { describe, expect, it, vi } from 'vitest'

import {
  createChatTurnRoutes,
  createSandboxChatProducer,
  type ChatTurnMessageStore,
  type ChatTurnProduceArgs,
  type ChatTurnRouteProducer,
} from '../../src/chat-routes/index'
import type { ChatMessagePart } from '../../src/chat-store/parts'
import type { InteractionRequestWire } from '../../src/interactions/index'
import { planToPersistedPart, type ChatPlan } from '../../src/plans/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'

// ── fakes ────────────────────────────────────────────────────────────────────

interface StoredMessage {
  id: string
  threadId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  parts?: ChatMessagePart[]
  model?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  costUsd?: number | null
}

function memoryMessageStore() {
  const rows: StoredMessage[] = []
  let nextId = 1
  const store: ChatTurnMessageStore = {
    async listMessages(threadId) {
      return rows.filter((row) => row.threadId === threadId)
    },
    async appendMessage(input) {
      const row: StoredMessage = { id: `m${nextId++}`, ...input }
      rows.push(row)
      return row
    },
  }
  return { store, rows }
}

/** Producer that streams the given events then reports the final text. */
function fakeProducer(
  events: Array<Record<string, unknown>>,
  finalText: string,
  extras: Partial<ChatTurnRouteProducer> = {},
): ChatTurnRouteProducer {
  return {
    stream: (async function* () {
      for (const event of events) yield event as { type: string; data?: Record<string, unknown> }
    })(),
    finalText: () => finalText,
    ...extras,
  }
}

function turnRequest(body: Record<string, unknown>): Request {
  return new Request('http://app.test/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function readLines(body: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
  const text = await new Response(body).text()
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function makeRoutes(overrides: Partial<Parameters<typeof createChatTurnRoutes>[0]> = {}) {
  const { store, rows } = memoryMessageStore()
  const turnStore = createMemoryTurnEventStore()
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) }
  const routes = createChatTurnRoutes({
    projectId: 'test-app',
    authorize: async () => ({ ok: true, tenantId: 'ws-1', userId: 'user-1', context: undefined }),
    store,
    turnStore,
    produce: () => fakeProducer([{ type: 'text', text: 'hi ' }, { type: 'text', text: 'there' }], 'hi there'),
    log: () => {},
    ...overrides,
  })
  return { routes, rows, turnStore, ctx, pending }
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('createChatTurnRoutes — turn', () => {
  it('streams the turn: turn marker first, then engine-framed producer events', async () => {
    const { routes, ctx, pending } = makeRoutes()
    const res = await routes.turn(turnRequest({ threadId: 't-1', content: 'hello' }), ctx)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')
    const lines = await readLines(res.body!)

    expect(lines[0]).toMatchObject({ type: 'turn' })
    expect(typeof lines[0]!.turnId).toBe('string')
    const textLines = lines.filter((l) => l.type === 'text')
    expect(textLines.map((l) => l.text)).toEqual(['hi ', 'there'])
    // The engine owns the lifecycle envelope.
    expect(lines.some((l) => String(l.type).startsWith('session.run.'))).toBe(true)
    await Promise.all(pending)
  })

  it('persists the user message on send and the assistant message on completion', async () => {
    const { routes, rows, ctx, pending } = makeRoutes({
      produce: () =>
        fakeProducer([{ type: 'text', text: 'answer' }], 'answer', {
          assistantParts: () => [{ type: 'text', text: 'answer' }],
          usage: () => ({ inputTokens: 11, outputTokens: 7, costUsd: 0.01 }),
          model: 'anthropic/claude',
        }),
    })
    const res = await routes.turn(turnRequest({ threadId: 't-1', content: 'question?' }), ctx)
    await readLines(res.body!)
    await Promise.all(pending)

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ role: 'user', content: 'question?', threadId: 't-1' })
    expect(rows[1]).toMatchObject({
      role: 'assistant',
      content: 'answer',
      model: 'anthropic/claude',
      inputTokens: 11,
      outputTokens: 7,
      costUsd: 0.01,
    })
    expect(rows[1]!.parts).toEqual([{ type: 'text', text: 'answer' }])
  })

  it('persists a durable plan part returned by the producer', async () => {
    const plan: ChatPlan = {
      planId: 'plan-1',
      revision: 1,
      body: '1. Research\n2. Execute',
      submittedAt: '2026-07-21T00:00:00.000Z',
      status: 'pending',
    }
    const { routes, rows, ctx, pending } = makeRoutes({
      produce: () => fakeProducer([{ type: 'plan.submitted', data: { plan } }], '', {
        assistantParts: () => [planToPersistedPart(plan)],
      }),
    })
    await readLines((await routes.turn(turnRequest({ threadId: 't-1', content: 'make a plan' }), ctx)).body!)
    await Promise.all(pending)

    expect(rows.find((row) => row.role === 'assistant')?.parts).toEqual([planToPersistedPart(plan)])
  })

  it('does not double-insert the user row on a retried turnId, and names the REUSED row', async () => {
    const produce = vi.fn((_args: ChatTurnProduceArgs<unknown>) => fakeProducer([{ type: 'text', text: 'ok' }], 'ok'))
    const { routes, rows, ctx, pending } = makeRoutes({ produce })
    const body = { threadId: 't-1', content: 'same question', turnId: 'turn-abc' }
    await readLines((await routes.turn(turnRequest(body), ctx)).body!)
    await Promise.all(pending.splice(0))
    await readLines((await routes.turn(turnRequest(body), ctx)).body!)
    await Promise.all(pending.splice(0))

    const userRows = rows.filter((r) => r.role === 'user')
    expect(userRows).toHaveLength(1)
    // The retry inserts nothing, so its id can only come from the reuse path —
    // and `priorMessages` deliberately excludes that row, so nothing else in
    // the produce args could supply it.
    expect(produce.mock.calls.map((call) => call[0]!.userMessageId)).toEqual([userRows[0]!.id, userRows[0]!.id])
  })

  it('authorize insertUserMessage:false suppresses the user-row insert but still runs the turn', async () => {
    const produce = vi.fn((_args: ChatTurnProduceArgs<unknown>) => fakeProducer([{ type: 'text', text: 'ack' }], 'ack'))
    const { routes, rows, ctx, pending } = makeRoutes({
      produce,
      authorize: async () => ({ ok: true, tenantId: 'ws-1', userId: 'user-1', context: undefined, insertUserMessage: false }),
    })
    await readLines((await routes.turn(turnRequest({ threadId: 't-1', content: 'synthetic follow-up' }), ctx)).body!)
    await Promise.all(pending)

    expect(produce).toHaveBeenCalledTimes(1)
    expect(rows.filter((r) => r.role === 'user')).toHaveLength(0)
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(1)
    // Resolved, and there is genuinely no row — distinct from "not yet known".
    expect(produce.mock.calls[0]![0]!.userMessageId).toBeNull()
  })

  it('authorize insertUserMessage:true cannot resurrect a deduped retry (AND-composition)', async () => {
    const { routes, rows, ctx, pending } = makeRoutes({
      authorize: async () => ({ ok: true, tenantId: 'ws-1', userId: 'user-1', context: undefined, insertUserMessage: true }),
    })
    const body = { threadId: 't-1', content: 'same', turnId: 'turn-abc' }
    await readLines((await routes.turn(turnRequest(body), ctx)).body!)
    await Promise.all(pending.splice(0))
    await readLines((await routes.turn(turnRequest(body), ctx)).body!)
    await Promise.all(pending.splice(0))

    expect(rows.filter((r) => r.role === 'user')).toHaveLength(1)
  })

  it('persists echoed file parts onto the user message and hands parts to the producer', async () => {
    const produce = vi.fn((_args: ChatTurnProduceArgs<unknown>) => fakeProducer([{ type: 'text', text: 'ok' }], 'ok'))
    const { routes, rows, ctx, pending } = makeRoutes({ produce })
    const filePart = { type: 'image', filename: 'a.png', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' }
    const res = await routes.turn(
      turnRequest({ threadId: 't-1', content: 'look at this', parts: [filePart] }),
      ctx,
    )
    await readLines(res.body!)
    await Promise.all(pending)

    const userRow = rows.find((r) => r.role === 'user')!
    expect(userRow.parts).toEqual([{ type: 'text', text: 'look at this' }, filePart])

    const args = produce.mock.calls[0]![0]
    expect(args.prompt).toEqual([{ type: 'text', text: 'look at this' }, filePart])
    expect(args.identity).toMatchObject({ tenantId: 'ws-1', sessionId: 't-1', userId: 'user-1', turnIndex: 0 })
    expect(args.executionId).toContain('test-app')
  })

  it('rejects a body with neither content nor parts nor mentions, and a missing threadId', async () => {
    const { routes, ctx } = makeRoutes()
    const empty = await routes.turn(turnRequest({ threadId: 't-1' }), ctx)
    expect(empty.status).toBe(400)
    expect((await empty.json() as { error: string }).error).toContain('mentions')
    expect((await routes.turn(turnRequest({ content: 'x' }), ctx)).status).toBe(400)
  })

  it('rejects inline parts over the byte budget with 413 (gateway-cap gate)', async () => {
    const { routes, ctx } = makeRoutes()
    const res = await routes.turn(
      turnRequest({
        threadId: 't-1',
        content: 'big',
        parts: [{ type: 'file', filename: 'big.bin', url: `data:application/octet-stream;base64,${'A'.repeat(1_000_001)}` }],
      }),
      ctx,
    )
    expect(res.status).toBe(413)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('PROMPT_PARTS_TOO_LARGE')
  })

  it('short-circuits with the authorize seam response', async () => {
    const { routes, rows, ctx } = makeRoutes({
      authorize: async () => ({ ok: false, response: Response.json({ error: 'nope' }, { status: 401 }) }),
    })
    const res = await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx)
    expect(res.status).toBe(401)
    expect(rows).toHaveLength(0)
  })
})

describe('createChatTurnRoutes — buffered replay', () => {
  it('replays the full turn after a simulated client drop', async () => {
    const { routes, ctx, pending } = makeRoutes({
      produce: () =>
        fakeProducer(
          Array.from({ length: 20 }, (_, i) => ({ type: 'text', text: `chunk${i} ` })),
          Array.from({ length: 20 }, (_, i) => `chunk${i} `).join(''),
        ),
    })
    const res = await routes.turn(turnRequest({ threadId: 't-9', content: 'go' }), ctx)

    // Read only the first chunk (the turn marker), then drop the connection.
    const reader = res.body!.getReader()
    const first = await reader.read()
    const firstLine = JSON.parse(new TextDecoder().decode(first.value).split('\n')[0]!) as { turnId: string }
    await reader.cancel()

    // The teed drain finishes the turn server-side.
    await Promise.all(pending)

    const replayRes = await routes.replay(
      new Request(`http://app.test/api/chat/replay/${firstLine.turnId}?fromSeq=0`),
      { turnId: firstLine.turnId },
    )
    expect(replayRes.status).toBe(200)
    const lines = await readLines(replayRes.body!)

    expect(lines[0]).toMatchObject({ type: 'turn', turnId: firstLine.turnId })
    const textLines = lines.filter((l) => l.type === 'text')
    const replayedText = textLines.map((l) => String(l.text)).join('')
    expect(replayedText).toBe(Array.from({ length: 20 }, (_, i) => `chunk${i} `).join(''))
    // Coalesced persistence: contiguous deltas merge per flush window instead
    // of landing as one row per token.
    expect(textLines.length).toBeLessThan(20)
    // Terminates with the status marker so clients know why the stream ended.
    expect(lines.at(-1)).toMatchObject({ type: 'turn_status', status: 'complete' })
  })

  it('authorizes replay through the same seam', async () => {
    const { routes } = makeRoutes({
      authorize: async (args) =>
        args.intent === 'replay'
          ? { ok: false, response: Response.json({ error: 'no' }, { status: 403 }) }
          : { ok: true, tenantId: 'ws-1', userId: 'user-1', context: undefined },
    })
    const res = await routes.replay(new Request('http://app.test/replay/x'), { turnId: 'x' })
    expect(res.status).toBe(403)
  })
})

describe('createChatTurnRoutes — running discovery', () => {
  it('reports a turn still running on the thread, then empty once it settles', async () => {
    const { routes, turnStore } = makeRoutes()
    // A turn buffering under this thread (what a detached, still-running turn
    // looks like in the store after a client reload).
    await turnStore.setStatus('turn-abc', 'running', 't-run')

    const runningRes = await routes.running(new Request('http://app.test/api/chat/running?threadId=t-run'))
    expect(runningRes.status).toBe(200)
    expect(await runningRes.json()).toEqual({ running: ['turn-abc'] })

    // A different thread's running turn is not reported here.
    await turnStore.setStatus('turn-other', 'running', 't-other')
    expect(
      await (await routes.running(new Request('http://app.test/api/chat/running?threadId=t-run'))).json(),
    ).toEqual({ running: ['turn-abc'] })

    // Once the turn settles, discovery reports none — the client falls back to
    // the persisted transcript.
    await turnStore.setStatus('turn-abc', 'complete', 't-run')
    expect(
      await (await routes.running(new Request('http://app.test/api/chat/running?threadId=t-run'))).json(),
    ).toEqual({ running: [] })
  })

  it('400s without a threadId and authorizes through the same seam', async () => {
    const { routes } = makeRoutes({
      authorize: async (args) =>
        args.intent === 'running'
          ? { ok: false, response: Response.json({ error: 'no' }, { status: 403 }) }
          : { ok: true, tenantId: 'ws-1', userId: 'user-1', context: undefined },
    })
    expect((await routes.running(new Request('http://app.test/api/chat/running'))).status).toBe(400)
    expect(
      (await routes.running(new Request('http://app.test/api/chat/running?threadId=t-1'))).status,
    ).toBe(403)
  })
})

describe('createChatTurnRoutes — product seams', () => {
  /** Read NDJSON lines off a live body until `predicate` is satisfied or EOF. */
  async function drainUntil(
    body: ReadableStream<Uint8Array>,
    seen: Array<Record<string, unknown>>,
    predicate: (seen: Array<Record<string, unknown>>) => boolean,
  ): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    while (!predicate(seen)) {
      const { value, done } = await reader.read()
      if (done) break
      for (const line of decoder.decode(value).split('\n').filter((l) => l.trim())) {
        seen.push(JSON.parse(line) as Record<string, unknown>)
      }
    }
    reader.releaseLock()
  }

  it('heartbeat: emits keepalives while the producer is quiet, then stops on the first real event', async () => {
    let releaseGate!: () => void
    const gate = new Promise<void>((r) => { releaseGate = r })
    const { routes, ctx, pending } = makeRoutes({
      produce: () => ({
        stream: (async function* () {
          await gate // silent window — keepalives should fire here
          yield { type: 'text', text: 'answer' }
        })(),
        finalText: () => 'answer',
      }),
      heartbeat: { intervalMs: 5, event: ({ tick }) => ({ type: 'keepalive', data: { tick } }) },
    })

    const res = await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx)
    const seen: Array<Record<string, unknown>> = []
    await drainUntil(res.body!, seen, (s) => s.filter((l) => l.type === 'keepalive').length >= 2)
    expect(seen.filter((l) => l.type === 'keepalive').length).toBeGreaterThanOrEqual(2)

    releaseGate()
    await drainUntil(res.body!, seen, (s) => s.some((l) => l.type === 'text' && l.text === 'answer'))
    await Promise.all(pending)

    const answerIndex = seen.findIndex((l) => l.type === 'text' && l.text === 'answer')
    expect(answerIndex).toBeGreaterThanOrEqual(0)
    // Window resets on the real event and the producer then completes with no
    // further silence — no keepalive may follow the answer.
    expect(seen.slice(answerIndex).filter((l) => l.type === 'keepalive')).toHaveLength(0)
  })

  it('beforeTurn: observes the assembled input and rewrites the prompt + prior messages', async () => {
    const produce = vi.fn((_args: ChatTurnProduceArgs<unknown>) => fakeProducer([{ type: 'text', text: 'ok' }], 'ok'))
    const observed: Array<string | unknown[]> = []
    const rewrittenPrior = [{ id: 'ctx', role: 'user' as const, content: 'injected', parts: null }]
    const { routes, ctx, pending } = makeRoutes({
      produce,
      beforeTurn: (args) => {
        observed.push(args.prompt)
        return { prompt: 'rewritten', priorMessages: rewrittenPrior }
      },
    })

    await readLines((await routes.turn(turnRequest({ threadId: 't-1', content: 'original' }), ctx)).body!)
    await Promise.all(pending)

    expect(observed).toEqual(['original']) // observed the route-assembled prompt
    const args = produce.mock.calls[0]![0]
    expect(args.prompt).toBe('rewritten')
    expect(args.priorMessages).toEqual(rewrittenPrior)
  })

  it('beforeTurn: a void return leaves the input untouched, and a context mutation reaches produce + onTurnComplete', async () => {
    // The second shipped shape of this seam (legal's): resolve request-scoped
    // state onto `context` and return NOTHING. The patch arm is not the only
    // contract — a `void` return must not be read as "patch with undefined".
    interface Ctx { resolved?: string }
    const { store } = memoryMessageStore()
    const produce = vi.fn((_args: ChatTurnProduceArgs<Ctx>) => fakeProducer([{ type: 'text', text: 'ok' }], 'ok'))
    const completed: Array<string | undefined> = []
    const pending: Promise<unknown>[] = []
    const routes = createChatTurnRoutes<Ctx>({
      projectId: 'test-app',
      authorize: async () => ({ ok: true, tenantId: 'ws-1', userId: 'user-1', context: {} }),
      store,
      turnStore: createMemoryTurnEventStore(),
      produce,
      beforeTurn: (args) => { args.context.resolved = 'from-beforeTurn' },
      onTurnComplete: async ({ context }) => { completed.push(context.resolved) },
      log: () => {},
    })

    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) }
    await readLines((await routes.turn(turnRequest({ threadId: 't-1', content: 'original' }), ctx)).body!)
    await Promise.all(pending)

    const args = produce.mock.calls[0]![0]!
    expect(args.prompt).toBe('original') // route-assembled value survives a void return
    expect(args.priorMessages).toEqual([])
    // Same object, threaded forward — this is what makes the mutation legal.
    expect(args.context.resolved).toBe('from-beforeTurn')
    expect(completed).toEqual(['from-beforeTurn'])
  })

  it('lifecycle: onTurnStart→onTurnComplete on success, onTurnStart→onTurnError on failure, always ordered', async () => {
    const events: string[] = []
    const completed: Array<string | null> = []
    const lifecycle = {
      onTurnStart: () => { events.push('start') },
      onTurnComplete: (info: { finalText: string; usage: { inputTokens?: number }; assistantMessageId: string | null }) =>
        {
          events.push(`complete:${info.finalText}:${info.usage.inputTokens ?? 0}`)
          completed.push(info.assistantMessageId)
        },
      onTurnError: () => { events.push('error') },
    }

    const ok = makeRoutes({
      lifecycle,
      produce: () => fakeProducer([{ type: 'text', text: 'yo' }], 'yo', { usage: () => ({ inputTokens: 3 }) }),
    })
    await readLines((await ok.routes.turn(turnRequest({ threadId: 't-1', content: 'q' }), ok.ctx)).body!)
    await Promise.all(ok.pending)
    expect(events).toEqual(['start', 'complete:yo:3'])
    // The telemetry seam names the same row the persistence seam wrote.
    expect(completed).toEqual([ok.rows.find((r) => r.role === 'assistant')!.id])

    events.length = 0
    const bad = makeRoutes({
      lifecycle,
      produce: () => fakeProducer([{ type: 'error', data: { message: 'boom' } }], ''),
    })
    await readLines((await bad.routes.turn(turnRequest({ threadId: 't-2', content: 'q' }), bad.ctx)).body!)
    await Promise.all(bad.pending)
    expect(events).toEqual(['start', 'error'])
  })

  it('contextGate: short-circuits with the product response before the producer runs', async () => {
    const produce = vi.fn(() => fakeProducer([{ type: 'text', text: 'should not run' }], 'x'))
    const { routes, rows, ctx } = makeRoutes({
      produce,
      contextGate: async () => ({ proceed: false, response: Response.json({ needContext: true }, { status: 409 }) }),
    })

    const res = await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ needContext: true })
    expect(produce).not.toHaveBeenCalled()
    // The user row is still recorded (a real user turn); no assistant row.
    expect(rows.filter((r) => r.role === 'user')).toHaveLength(1)
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(0)
  })

  it('contextGate: decides from the request body it is handed (a turn already answered is refused)', async () => {
    // The second shipped shape (creative's): the verdict is keyed on the wire
    // payload, not on ambient state — so the seam must receive the SAME parsed,
    // validated body the route used, with no re-parse of the request.
    const answered = new Set(['turn-a'])
    const produce = vi.fn(() => fakeProducer([{ type: 'text', text: 'x' }], 'x'))
    const seenBodies: Array<string | undefined> = []
    const gate = {
      produce,
      contextGate: async (args: ChatTurnProduceArgs<unknown>) => {
        seenBodies.push(args.body.turnId)
        return answered.has(args.body.turnId ?? '')
          ? { proceed: false as const, response: Response.json({ code: 'already_answered' }, { status: 409 }) }
          : { proceed: true as const }
      },
    }

    const refused = makeRoutes(gate)
    const res = await refused.routes.turn(turnRequest({ threadId: 't-1', content: 'hi', turnId: 'turn-a' }), refused.ctx)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ code: 'already_answered' })
    expect(produce).not.toHaveBeenCalled()
    expect(refused.rows.filter((r) => r.role === 'assistant')).toHaveLength(0)

    const allowed = makeRoutes(gate)
    const ok = await allowed.routes.turn(turnRequest({ threadId: 't-2', content: 'hi', turnId: 'turn-b' }), allowed.ctx)
    expect(ok.status).toBe(200)
    await readLines(ok.body!)
    await Promise.all(allowed.pending)
    expect(produce).toHaveBeenCalledTimes(1)
    expect(seenBodies).toEqual(['turn-a', 'turn-b'])
  })

  it('insertUserMessage:false: the post-insert seams see userMessageId null, not a stale row', async () => {
    // The cross-seam half of the graduated `insertUserMessage` contract: a
    // suppressed insert with nothing to reuse must surface as `null`, never as
    // some other row in the thread.
    const seen: Record<string, string | null | undefined> = {}
    const produce = vi.fn((args: ChatTurnProduceArgs<unknown>) => {
      seen.produce = args.userMessageId
      return fakeProducer([{ type: 'text', text: 'ok' }], 'ok')
    })
    const { routes, rows, ctx, pending } = makeRoutes({
      authorize: async () => ({ ok: true, tenantId: 'ws-1', userId: 'user-1', context: undefined, insertUserMessage: false }),
      produce,
      contextGate: (args) => { seen.contextGate = args.userMessageId; return { proceed: true as const } },
      beforeTurn: (args) => { seen.beforeTurn = args.userMessageId },
    })

    await readLines((await routes.turn(turnRequest({ threadId: 't-1', content: 'approve' }), ctx)).body!)
    await Promise.all(pending)

    expect(seen).toEqual({ contextGate: null, beforeTurn: null, produce: null })
    expect(rows.filter((r) => r.role === 'user')).toHaveLength(0)
    // The turn itself still ran — suppression hides the bubble, not the answer.
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(1)
  })

  it('turnLock: acquires before the turn and releases in finally even when the turn throws', async () => {
    const order: string[] = []
    const turnLock = {
      acquire: () => { order.push('acquire'); return { acquired: true as const, handle: 'h1' } },
      release: (handle: unknown) => { order.push(`release:${String(handle)}`) },
    }
    const { routes, ctx } = makeRoutes({
      turnLock,
      beforeTurn: () => { order.push('beforeTurn'); throw new Error('kaboom') },
    })

    await expect(routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx)).rejects.toThrow('kaboom')
    expect(order).toEqual(['acquire', 'beforeTurn', 'release:h1'])
  })

  it('turnLock: rejects with the product response when already held (no producer run)', async () => {
    const produce = vi.fn(() => fakeProducer([{ type: 'text', text: 'x' }], 'x'))
    const { routes, rows, ctx } = makeRoutes({
      produce,
      turnLock: {
        acquire: () => ({ acquired: false as const, response: Response.json({ code: 'in_flight' }, { status: 409 }) }),
        release: () => {},
      },
    })
    const res = await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx)
    expect(res.status).toBe(409)
    expect(produce).not.toHaveBeenCalled()
    expect(rows).toHaveLength(0) // no user row when the lock is held
  })

  it('transformFinalText: redacts the persisted text PARTS, not just the scalar finalText', async () => {
    // The at-rest leak this closes: legal wires redactPII as transformFinalText;
    // the engine redacts the scalar, but message.parts streamed straight off the
    // producer kept the raw PII until now.
    const redact = (text: string) => text.replaceAll('SSN 123', 'SSN [redacted]')
    const { routes, rows, ctx, pending } = makeRoutes({
      transformFinalText: redact,
      produce: () =>
        fakeProducer([{ type: 'text', text: 'Your SSN 123 is on file' }], 'Your SSN 123 is on file', {
          assistantParts: () => [
            { type: 'tool', id: 'c1', tool: 'lookup', state: { status: 'completed', output: { ok: true } } },
            { type: 'text', text: 'Your SSN 123 is on file' },
          ],
        }),
    })
    await readLines((await routes.turn(turnRequest({ threadId: 't-1', content: 'q' }), ctx)).body!)
    await Promise.all(pending)

    const assistant = rows.find((r) => r.role === 'assistant')!
    // Engine already redacts the scalar column...
    expect(assistant.content).toBe('Your SSN [redacted] is on file')
    // ...and now the persisted text PART is redacted too.
    const textPart = (assistant.parts ?? []).find((p) => p.type === 'text') as { text: string } | undefined
    expect(textPart?.text).toBe('Your SSN [redacted] is on file')
    // No raw PII survives anywhere in the persisted parts.
    expect(JSON.stringify(assistant.parts ?? [])).not.toContain('SSN 123')
  })

  it('onTurnComplete: reports failed:true + failureReason on a terminal error event (not a clean complete)', async () => {
    const calls: Array<{ failed: boolean; failureReason?: string; finalText: string; assistantMessageId: string | null }> = []
    const { routes, rows, ctx, pending } = makeRoutes({
      produce: () => fakeProducer([{ type: 'error', data: { message: 'model 402 payment required' } }], ''),
      onTurnComplete: async ({ failed, failureReason, finalText, assistantMessageId }) => {
        calls.push({ failed, ...(failureReason ? { failureReason } : {}), finalText, assistantMessageId })
      },
    })
    await readLines((await routes.turn(turnRequest({ threadId: 't-1', content: 'q' }), ctx)).body!)
    await Promise.all(pending)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.failed).toBe(true)
    expect(calls[0]!.failureReason).toBe('model 402 payment required')
    // This error carried no text at all, so no assistant row was written — the
    // id reports that honestly instead of naming the user row.
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(0)
    expect(calls[0]!.assistantMessageId).toBeNull()
  })

  it('persists partial content and reports failed:true when the producer catches a severed stream', async () => {
    const calls: Array<{ failed: boolean; failureReason?: string; finalText: string; assistantMessageId: string | null }> = []
    const { routes, rows, ctx, pending } = makeRoutes({
      produce: () => createSandboxChatProducer({
        events: (async function* () {
          yield {
            type: 'message.part.updated',
            data: { part: { type: 'text', id: 't1', text: 'Partial answer' }, delta: 'Partial answer' },
          }
          throw new Error('connection dropped')
        })(),
        log: () => {},
      }),
      onTurnComplete: async ({ failed, failureReason, finalText, assistantMessageId }) => {
        calls.push({ failed, ...(failureReason ? { failureReason } : {}), finalText, assistantMessageId })
      },
    })

    const response = await routes.turn(turnRequest({ threadId: 't-severed', content: 'q' }), ctx)
    const lines = await readLines(response.body!)
    await Promise.all(pending)

    expect(lines).toContainEqual(expect.objectContaining({
      type: 'error',
      data: expect.objectContaining({ code: 'sandbox.stream_failed' }),
    }))
    const assistant = rows.find((row) => row.role === 'assistant')
    expect(assistant?.content).toContain('Partial answer')
    expect(assistant?.content).toContain('The sandbox model stream stopped before a clean completion.')
    expect(assistant?.parts).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('Partial answer\n\n---\nThe sandbox model stream stopped'),
      }),
    ])
    expect(calls).toEqual([expect.objectContaining({
      failed: true,
      failureReason: expect.stringContaining('connection dropped'),
      finalText: expect.stringContaining('Partial answer'),
      // failed:true AND a real row — the pairing a product needs to render an
      // error against the message it actually wrote.
      assistantMessageId: assistant!.id,
    })])
  })

  it('onTurnComplete: reports failed:false on a clean turn', async () => {
    const seen: boolean[] = []
    const { routes, ctx, pending } = makeRoutes({
      produce: () => fakeProducer([{ type: 'text', text: 'ok' }], 'ok'),
      onTurnComplete: async ({ failed }) => { seen.push(failed) },
    })
    await readLines((await routes.turn(turnRequest({ threadId: 't-1', content: 'q' }), ctx)).body!)
    await Promise.all(pending)
    expect(seen).toEqual([false])
  })

  it('onRawEvent: observes producer events before the engine frames them', async () => {
    const raw: string[] = []
    const { routes, ctx, pending } = makeRoutes({
      produce: () => fakeProducer([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], 'ab'),
      onRawEvent: (event) => { raw.push(event.type) },
    })
    await readLines((await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx)).body!)
    await Promise.all(pending)
    // Exactly the producer's own events — no engine lifecycle envelopes.
    expect(raw).toEqual(['text', 'text'])
  })

  it('onRawEvent: never sees an injected keepalive, even though the client does', async () => {
    // The tap sits UPSTREAM of heartbeat injection, so a synthetic event cannot
    // reach a product's trace and be mistaken for something the agent emitted.
    let releaseGate!: () => void
    const gate = new Promise<void>((r) => { releaseGate = r })
    const raw: string[] = []
    const { routes, ctx, pending } = makeRoutes({
      produce: () => ({
        stream: (async function* () {
          await gate
          yield { type: 'text', text: 'answer' }
        })(),
        finalText: () => 'answer',
      }),
      heartbeat: { intervalMs: 5, event: ({ tick }) => ({ type: 'keepalive', data: { tick } }) },
      onRawEvent: (event) => { raw.push(event.type) },
    })

    const res = await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx)
    const seen: Array<Record<string, unknown>> = []
    await drainUntil(res.body!, seen, (s) => s.filter((l) => l.type === 'keepalive').length >= 2)
    releaseGate()
    await drainUntil(res.body!, seen, (s) => s.some((l) => l.type === 'text' && l.text === 'answer'))
    await Promise.all(pending)

    // The client got keepalives; the raw tap got only the producer's own event.
    expect(seen.filter((l) => l.type === 'keepalive').length).toBeGreaterThanOrEqual(2)
    expect(raw).toEqual(['text'])
  })

  it('onRawEvent: a throwing handler is swallowed — the stream and the turn still complete', async () => {
    // Telemetry is an observer. A broken sink must not truncate the client's
    // stream, drop an event, or fail the turn.
    const completed: boolean[] = []
    const { routes, rows, ctx, pending } = makeRoutes({
      produce: () => fakeProducer([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], 'ab'),
      onRawEvent: () => { throw new Error('trace sink down') },
      onTurnComplete: async ({ failed }) => { completed.push(failed) },
    })

    const res = await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx)
    expect(res.status).toBe(200)
    const lines = await readLines(res.body!)
    await Promise.all(pending)

    expect(lines.filter((l) => l.type === 'text').map((l) => l.text)).toEqual(['a', 'b'])
    expect(completed).toEqual([false])
    expect(rows.find((r) => r.role === 'assistant')!.content).toBe('ab')
  })
})

describe('createChatTurnRoutes — persisted message ids', () => {
  it('hands every post-insert seam the user row the factory just wrote', async () => {
    const seen: Record<string, string | null | undefined> = {}
    const produce = vi.fn((args: ChatTurnProduceArgs<unknown>) => {
      seen.produce = args.userMessageId
      return fakeProducer([{ type: 'text', text: 'ok' }], 'ok')
    })
    const { routes, rows, ctx, pending } = makeRoutes({
      produce,
      contextGate: (args) => { seen.contextGate = args.userMessageId; return { proceed: true as const } },
      beforeTurn: (args) => { seen.beforeTurn = args.userMessageId },
    })

    await readLines((await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx)).body!)
    await Promise.all(pending)

    const userRow = rows.find((r) => r.role === 'user')!
    expect(seen).toEqual({
      contextGate: userRow.id,
      beforeTurn: userRow.id,
      produce: userRow.id,
    })
  })

  it('turnLock.acquire sees no user id because it runs before the insert', async () => {
    let seenAtAcquire: string | null | undefined = 'unset'
    let rowsAtAcquire = -1
    const { routes, rows, ctx, pending } = makeRoutes({
      turnLock: {
        acquire: (args) => {
          seenAtAcquire = args.userMessageId
          rowsAtAcquire = rows.length
          return { acquired: true as const }
        },
        release: () => {},
      },
    })
    await readLines((await routes.turn(turnRequest({ threadId: 't-1', content: 'hi' }), ctx)).body!)
    await Promise.all(pending)

    // `undefined` — not "resolved to nothing". The second assertion is what
    // actually pins WHY: the lock is acquired before any side effect, so the
    // row it would name does not exist yet.
    expect(seenAtAcquire).toBeUndefined()
    expect(rowsAtAcquire).toBe(0)
  })

  it('reports the assistant row to onTurnComplete', async () => {
    const seen: Array<string | null> = []
    const { routes, rows, ctx, pending } = makeRoutes({
      onTurnComplete: async ({ assistantMessageId }) => { seen.push(assistantMessageId) },
    })
    await readLines((await routes.turn(turnRequest({ threadId: 't-1', content: 'q' }), ctx)).body!)
    await Promise.all(pending)

    const assistantRow = rows.find((r) => r.role === 'assistant')!
    expect(seen).toEqual([assistantRow.id])
    // The id names a row that is really there — the thing the "newest row in
    // the thread" workaround was approximating.
    expect(rows.filter((r) => r.id === seen[0])).toHaveLength(1)
  })

  it('reports null when an empty turn leaves no assistant row', async () => {
    const seen: Array<string | null> = []
    const { routes, rows, ctx, pending } = makeRoutes({
      produce: () => fakeProducer([], ''),
      onTurnComplete: async ({ assistantMessageId }) => { seen.push(assistantMessageId) },
    })
    await readLines((await routes.turn(turnRequest({ threadId: 't-1', content: 'q' }), ctx)).body!)
    await Promise.all(pending)

    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(0)
    expect(seen).toEqual([null])
  })

  it('reports null for both ids when the store returns no row from appendMessage', async () => {
    // `ChatTurnMessageStore.appendMessage` is typed `Promise<unknown>`, so a
    // product adapter resolving `void` is legal. It must degrade to "no id",
    // never to a fabricated one, and must not fail the turn.
    const store: ChatTurnMessageStore = {
      async listMessages() { return [] },
      async appendMessage() { /* returns undefined */ },
    }
    const produce = vi.fn((_args: ChatTurnProduceArgs<unknown>) => fakeProducer([{ type: 'text', text: 'ok' }], 'ok'))
    const seen: Array<string | null> = []
    const { routes, ctx, pending } = makeRoutes({
      store,
      produce,
      onTurnComplete: async ({ assistantMessageId }) => { seen.push(assistantMessageId) },
    })

    const res = await routes.turn(turnRequest({ threadId: 't-1', content: 'q' }), ctx)
    expect(res.status).toBe(200)
    await readLines(res.body!)
    await Promise.all(pending)

    expect(produce.mock.calls[0]![0]!.userMessageId).toBeNull()
    expect(seen).toEqual([null])
  })
})

describe('createChatTurnRoutes — interactions composition', () => {
  function wireQuestion(id: string): InteractionRequestWire {
    return {
      id,
      kind: 'question',
      title: 'Proceed?',
      answerSpec: {
        fields: [{
          type: 'select',
          name: 'q0',
          label: 'Proceed?',
          required: true,
          multi: false,
          options: [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }],
        }],
      },
    } as InteractionRequestWire
  }

  it('answers a sidecar ask round-trip through the composed /interactions route', async () => {
    const outstanding = new Map([['ask-1', wireQuestion('ask-1')]])
    const posts: Array<Record<string, unknown>> = []
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return Response.json({ data: { interactions: [...outstanding.values()] } })
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      posts.push(body)
      outstanding.delete(String(body.id))
      return Response.json({ data: { ok: true } })
    }) as typeof fetch

    const { routes } = makeRoutes({
      interactions: {
        resolveConnection: async () => ({
          ok: true,
          connection: { runtimeUrl: 'http://sidecar.test', sessionId: 't-1', fetchImpl },
        }),
        logger: { warn: () => {}, error: () => {} },
      },
    })

    expect(routes.interactions).not.toBeNull()
    const res = await routes.interactions!.answer(
      new Request('http://app.test/api/chat/interactions', {
        method: 'POST',
        body: JSON.stringify({ id: 'ask-1', outcome: 'accepted', data: { q0: 'Yes' } }),
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(posts).toEqual([{ id: 'ask-1', outcome: 'accepted', data: { q0: 'Yes' } }])
  })

  it('is null when the product wires no interactions channel', () => {
    const { routes } = makeRoutes()
    expect(routes.interactions).toBeNull()
  })
})

describe('createChatTurnRoutes — file mentions', () => {
  it('persists mentions as their own parts, alongside text and file parts', async () => {
    const { routes, rows, ctx, pending } = makeRoutes()
    const res = await routes.turn(
      turnRequest({
        threadId: 't-mentions',
        content: 'compare @docs/a.md with @assets/logo.png',
        mentions: [
          { path: 'docs/a.md', name: 'a.md' },
          { path: 'assets/logo.png', name: 'logo.png', size: 42 },
        ],
      }),
      ctx,
    )
    expect(res.status).toBe(200)
    await readLines(res.body!)
    await Promise.all(pending)

    const user = rows.find((row) => row.role === 'user')!
    expect(user.parts).toEqual([
      { type: 'text', text: 'compare @docs/a.md with @assets/logo.png' },
      { type: 'mention', mentionKind: 'file', path: 'docs/a.md', name: 'a.md' },
      { type: 'mention', mentionKind: 'image', path: 'assets/logo.png', name: 'logo.png', size: 42 },
    ])
  })

  it('hands the produce seam the VALIDATED, deduped mention list on the payload', async () => {
    let seen: ChatTurnProduceArgs<void> | undefined
    const { routes, ctx, pending } = makeRoutes({
      produce: (args: ChatTurnProduceArgs<void>) => {
        seen = args
        return fakeProducer([], 'ok')
      },
    })
    const res = await routes.turn(
      turnRequest({
        threadId: 't-mentions-2',
        content: 'read @docs/a.md',
        mentions: [
          { path: 'docs/a.md', name: 'a.md', extra: 'dropped' },
          { path: 'docs/a.md', name: 'again.md' },
        ],
      }),
      ctx,
    )
    await readLines(res.body!)
    await Promise.all(pending)

    expect(seen?.body.mentions).toEqual([{ path: 'docs/a.md', name: 'a.md' }])
  })

  it('rejects a traversal path with a 400 before any side effect', async () => {
    const { routes, rows, ctx } = makeRoutes()
    const res = await routes.turn(
      turnRequest({
        threadId: 't-mentions-3',
        content: 'read it',
        mentions: [{ path: '../../etc/passwd', name: 'passwd' }],
      }),
      ctx,
    )

    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toContain('mentions[0]')
    expect(rows).toHaveLength(0)
  })

  it('does not count mentions against the inline-parts byte budget (they are paths, not bytes)', async () => {
    const { routes, ctx, pending } = makeRoutes({ maxInlinePartBytes: 32 })
    const res = await routes.turn(
      turnRequest({
        threadId: 't-mentions-4',
        content: 'go',
        // A real (tiny) inline part, so the cap is genuinely exercised: with
        // `parts` absent the assertion short-circuits on an empty list and the
        // test would pass even with the cap removed.
        parts: [{ type: 'file', filename: 't.txt', url: 'data:text/plain;base64,QUJD' }],
        mentions: Array.from({ length: 8 }, (_, i) => ({
          path: `docs/a-very-long-path-name-${i}.md`,
          name: `a-very-long-path-name-${i}.md`,
        })),
      }),
      ctx,
    )
    expect(res.status).toBe(200)
    await readLines(res.body!)
    await Promise.all(pending)
  })

  it('accepts a mentions-only turn — "@chart.png" with no prose is a real ask', async () => {
    const { routes, rows, ctx, pending } = makeRoutes()
    const res = await routes.turn(
      turnRequest({
        threadId: 't-mentions-only',
        mentions: [{ path: 'reports/chart.png', name: 'chart.png' }],
      }),
      ctx,
    )
    expect(res.status).toBe(200)
    await readLines(res.body!)
    await Promise.all(pending)

    // The empty text part is how EVERY content-less turn already persists (a
    // parts-only turn produces the same leading part); mentions inherit it
    // rather than introducing a shape of their own.
    expect(rows.find((row) => row.role === 'user')!.parts).toEqual([
      { type: 'text', text: '' },
      { type: 'mention', mentionKind: 'image', path: 'reports/chart.png', name: 'chart.png' },
    ])
  })

  it('leaves a turn without mentions byte-identical to before', async () => {
    const { routes, rows, ctx, pending } = makeRoutes()
    const res = await routes.turn(turnRequest({ threadId: 't-none', content: 'plain' }), ctx)
    await readLines(res.body!)
    await Promise.all(pending)

    expect(rows.find((row) => row.role === 'user')!.parts)
      .toEqual([{ type: 'text', text: 'plain' }])
  })
})
