import { describe, expect, it, vi } from 'vitest'

import {
  createChatTurnRoutes,
  settleTurnResponse,
  TURN_INTENT_EVENT,
  TURN_PROGRESS_FIRST,
  TURN_PROGRESS_HEADER,
  type ChatTurnIntentLine,
  type ChatTurnMessageStore,
  type ChatTurnProduceArgs,
  type ChatTurnRouteProducer,
} from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { consumeChatStream } from '../../src/web-react/chat-stream'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function routesWith(intentLine: ChatTurnIntentLine<void>, opts: { slowAnswer?: boolean } = {}) {
  const rows: Array<{ id: string; threadId: string; role: string; content: string }> = [
    { id: 'm0', threadId: 't-1', role: 'user', content: 'We sell a sandbox for AI agents.' },
    { id: 'm1', threadId: 't-1', role: 'assistant', content: 'Noted.' },
  ]
  let next = 2
  const store: ChatTurnMessageStore = {
    async listMessages(threadId) { return rows.filter((row) => row.threadId === threadId) as never },
    async appendMessage(input) { const row = { id: `m${next++}`, ...input }; rows.push(row); return row },
  }
  const produced: Array<ChatTurnProduceArgs<void>> = []
  const pending: Promise<unknown>[] = []
  const routes = createChatTurnRoutes({
    projectId: 'test-app',
    authorize: async () => ({ ok: true, tenantId: 'ws-1', userId: 'user-1', context: undefined }),
    store,
    turnStore: createMemoryTurnEventStore(),
    incrementalPersistence: false,
    log: () => {},
    intentLine,
    produce: (args): ChatTurnRouteProducer => {
      produced.push(args)
      return {
        stream: (async function* () {
          yield { type: 'text', text: 'First answer words.' } as { type: string }
          if (opts.slowAnswer) await sleep(120)
          yield { type: 'text', text: ' More.' } as { type: string }
        })(),
        finalText: () => 'First answer words. More.',
      }
    },
  })
  const request = (progressFirst = true) => new Request('http://app.test/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(progressFirst ? { [TURN_PROGRESS_HEADER]: TURN_PROGRESS_FIRST } : {}) },
    body: JSON.stringify({ threadId: 't-1', content: 'Compare our pricing with E2B and Docker.' }),
  })
  return { routes, produced, request, ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) }, pending }
}

async function lines(response: Response): Promise<Array<Record<string, unknown>>> {
  return (await response.text()).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
}

describe('chat turn intent line', () => {
  it('streams one intent line before the answer and hands the agent the same line', async () => {
    const generate = vi.fn(async () => '  Comparing your pricing with E2B and Docker,\n then I\'ll draft the table.  ')
    const { routes, produced, request, ctx, pending } = routesWith({ generate })
    const all = await lines(await routes.turn(request(), ctx))
    await Promise.all(pending)

    const intents = all.filter((event) => event.type === TURN_INTENT_EVENT)
    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({ data: { text: "Comparing your pricing with E2B and Docker, then I'll draft the table." } })
    expect(all.findIndex((event) => event.type === TURN_INTENT_EVENT))
      .toBeLessThan(all.findIndex((event) => event.type === 'text'))
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Compare our pricing with E2B and Docker.',
      history: expect.arrayContaining([{ role: 'user', content: 'We sell a sandbox for AI agents.' }]),
      threadId: 't-1',
    }))
    await expect(produced[0]?.intentLine).resolves.toBe("Comparing your pricing with E2B and Docker, then I'll draft the table.")
  })

  it('shows nothing when the line is late or fails, and the turn answers as before', async () => {
    let aborted = false
    const late: ChatTurnIntentLine<void> = {
      timeoutMs: 20,
      generate: async ({ signal }) => {
        signal.addEventListener('abort', () => { aborted = true })
        await sleep(200)
        return 'Too late to help.'
      },
    }
    for (const intentLine of [late, { generate: async () => { throw new Error('router down') } }, { generate: async () => '   ' }]) {
      const { routes, produced, request, ctx, pending } = routesWith(intentLine)
      const all = await lines(await routes.turn(request(), ctx))
      await Promise.all(pending)
      expect(all.some((event) => event.type === TURN_INTENT_EVENT)).toBe(false)
      expect(all.some((event) => event.type === 'text' && event.text === 'First answer words.')).toBe(true)
      await expect(produced[0]?.intentLine).resolves.toBeNull()
    }
    expect(aborted).toBe(true)
  })

  it('a line that arrives while the answer streams lands between whole lines', async () => {
    const { routes, request, ctx, pending } = routesWith({ generate: async () => { await sleep(40); return 'Checking the pricing pages.' } }, { slowAnswer: true })
    const all = await lines(await routes.turn(request(), ctx))
    await Promise.all(pending)
    expect(all.filter((event) => event.type === TURN_INTENT_EVENT)).toHaveLength(1)
  })

  it('a client that does not ask for progress gets no line, but the agent still gets it', async () => {
    const { routes, produced, request, ctx, pending } = routesWith({ generate: async () => 'Checking the pricing pages.' })
    const response = await routes.turn(request(false), ctx)
    expect((await response.text()).includes(TURN_INTENT_EVENT)).toBe(false)
    await Promise.all(pending)
    await expect(produced[0]?.intentLine).resolves.toBe('Checking the pricing pages.')
  })

  it('reaches the web client through onIntent before its first text', async () => {
    const { routes, request, ctx } = routesWith({ generate: async () => 'Checking the pricing pages.' })
    const response = await routes.turn(request(), ctx)
    const order: string[] = []
    await consumeChatStream(response.body!, {
      onIntent: (intent) => { order.push(`intent:${intent.text}`) },
      onText: (delta) => { order.push(`text:${delta}`) },
    })
    expect(order[0]).toBe('intent:Checking the pricing pages.')
    expect(order).toContain('text:First answer words.')
  })

  it('a refusal the route answers after the line still settles with its own status', async () => {
    const lockHeld = createChatTurnRoutes({
      projectId: 'test-app',
      authorize: async () => ({ ok: true, tenantId: 'ws-1', userId: 'user-1', context: undefined }),
      store: { async listMessages() { return [] }, async appendMessage(input) { return { id: 'm1', ...input } } },
      turnStore: createMemoryTurnEventStore(),
      incrementalPersistence: false,
      log: () => {},
      intentLine: { generate: async () => 'Checking the pricing pages.' },
      turnLock: { acquire: async () => { await sleep(30); return { acquired: false as const, response: Response.json({ error: 'busy' }, { status: 409 }) } }, release: () => {} },
      produce: () => { throw new Error('must not run') },
    })
    const intents: string[] = []
    const settled = await settleTurnResponse(
      await lockHeld.turn(new Request('http://app.test/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [TURN_PROGRESS_HEADER]: TURN_PROGRESS_FIRST },
        body: JSON.stringify({ threadId: 't-1', content: 'Compare pricing.' }),
      })),
      () => {},
      (intent) => { intents.push(intent.text) },
    )
    expect(settled.status).toBe(409)
    expect(intents).toEqual(['Checking the pricing pages.'])
  })
})
