import { describe, expect, it } from 'vitest'
import { createChatTurnRoutes, type ChatTurnMessageStore, type ChatTurnRouteProducer } from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'

function producer(events: Array<{ type: string; text?: string }>, delayMs: number): ChatTurnRouteProducer {
  return {
    stream: (async function* () {
      for (const event of events) {
        await new Promise(resolve => setTimeout(resolve, delayMs))
        yield event as never
      }
    })(),
    finalText: () => events.map(event => event.text ?? '').join(''),
  }
}

async function runTurn(events: Array<{ type: string; text?: string }>) {
  const store: ChatTurnMessageStore = { async listMessages() { return [] }, async appendMessage() { return { id: 'm' } } }
  const settled: Array<{ firstTextMs?: number; durationMs: number }> = []
  const pending: Promise<unknown>[] = []
  const routes = createChatTurnRoutes<Record<string, never>>({
    projectId: 'turn-timing', store, turnStore: createMemoryTurnEventStore(), incrementalPersistence: false, log: () => {},
    authorize: async () => ({ ok: true, tenantId: 'ws-1', userId: 'u-1', context: {} }),
    produce: () => producer(events, 30),
    lifecycle: {
      onTurnComplete: info => { settled.push({ firstTextMs: info.firstTextMs, durationMs: info.durationMs }) },
      onTurnError: info => { settled.push({ firstTextMs: info.firstTextMs, durationMs: info.durationMs }) },
    },
  })
  const response = await routes.turn(new Request('http://app.test/api/chat', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: 't-1', content: 'hi' }) }),
  { waitUntil: (p: Promise<unknown>) => { pending.push(p) } })
  await response.text()
  await Promise.all(pending)
  return settled
}

describe('chat turn timing', () => {
  it('reports when the first visible word streamed, skipping blank text', async () => {
    const [turn] = await runTurn([{ type: 'usage' }, { type: 'text', text: '  ' }, { type: 'text', text: 'Four' }, { type: 'text', text: ' rooms.' }])
    expect(turn!.firstTextMs).toBeGreaterThanOrEqual(80)
    expect(turn!.firstTextMs!).toBeLessThan(turn!.durationMs)
  })

  it('omits it when no word streamed', async () => {
    const [turn] = await runTurn([{ type: 'usage' }])
    expect(turn!.firstTextMs).toBeUndefined()
  })
})
