import { describe, expect, it, vi } from 'vitest'

import {
  createChatTurnRoutes,
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

  it('does not double-insert the user row on a retried turnId', async () => {
    const { routes, rows, ctx, pending } = makeRoutes()
    const body = { threadId: 't-1', content: 'same question', turnId: 'turn-abc' }
    await readLines((await routes.turn(turnRequest(body), ctx)).body!)
    await Promise.all(pending.splice(0))
    await readLines((await routes.turn(turnRequest(body), ctx)).body!)
    await Promise.all(pending.splice(0))

    expect(rows.filter((r) => r.role === 'user')).toHaveLength(1)
  })

  it('authorize insertUserMessage:false suppresses the user-row insert but still runs the turn', async () => {
    const produce = vi.fn(() => fakeProducer([{ type: 'text', text: 'ack' }], 'ack'))
    const { routes, rows, ctx, pending } = makeRoutes({
      produce,
      authorize: async () => ({ ok: true, tenantId: 'ws-1', userId: 'user-1', context: undefined, insertUserMessage: false }),
    })
    await readLines((await routes.turn(turnRequest({ threadId: 't-1', content: 'synthetic follow-up' }), ctx)).body!)
    await Promise.all(pending)

    expect(produce).toHaveBeenCalledTimes(1)
    expect(rows.filter((r) => r.role === 'user')).toHaveLength(0)
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(1)
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

  it('rejects a body with neither content nor parts, and a missing threadId', async () => {
    const { routes, ctx } = makeRoutes()
    expect((await routes.turn(turnRequest({ threadId: 't-1' }), ctx)).status).toBe(400)
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

  it('lifecycle: onTurnStart→onTurnComplete on success, onTurnStart→onTurnError on failure, always ordered', async () => {
    const events: string[] = []
    const lifecycle = {
      onTurnStart: () => { events.push('start') },
      onTurnComplete: (info: { finalText: string; usage: { inputTokens?: number } }) =>
        { events.push(`complete:${info.finalText}:${info.usage.inputTokens ?? 0}`) },
      onTurnError: () => { events.push('error') },
    }

    const ok = makeRoutes({
      lifecycle,
      produce: () => fakeProducer([{ type: 'text', text: 'yo' }], 'yo', { usage: () => ({ inputTokens: 3 }) }),
    })
    await readLines((await ok.routes.turn(turnRequest({ threadId: 't-1', content: 'q' }), ok.ctx)).body!)
    await Promise.all(ok.pending)
    expect(events).toEqual(['start', 'complete:yo:3'])

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
    const calls: Array<{ failed: boolean; failureReason?: string; finalText: string }> = []
    const { routes, ctx, pending } = makeRoutes({
      produce: () => fakeProducer([{ type: 'error', data: { message: 'model 402 payment required' } }], ''),
      onTurnComplete: async ({ failed, failureReason, finalText }) => {
        calls.push({ failed, ...(failureReason ? { failureReason } : {}), finalText })
      },
    })
    await readLines((await routes.turn(turnRequest({ threadId: 't-1', content: 'q' }), ctx)).body!)
    await Promise.all(pending)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.failed).toBe(true)
    expect(calls[0]!.failureReason).toBe('model 402 payment required')
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

  it('leaves a turn without mentions byte-identical to before', async () => {
    const { routes, rows, ctx, pending } = makeRoutes()
    const res = await routes.turn(turnRequest({ threadId: 't-none', content: 'plain' }), ctx)
    await readLines(res.body!)
    await Promise.all(pending)

    expect(rows.find((row) => row.role === 'user')!.parts)
      .toEqual([{ type: 'text', text: 'plain' }])
  })
})
