import { expect, it } from 'vitest'
import { createChatTurnRoutes, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { createProductLimitAlarms, withD1LimitAlarms } from '../../src/launch-invariants/index'
import type { TurnPhaseTiming, TurnTraceSnapshot } from '../../src/turn-trace/index'
import { sqliteD1 } from '../launch-invariants/sqlite-d1'

/** Real SQLite, the production D1 proxy and composed turn route; no mocked queries or clocks. */
it('keeps domain phase clocks and SQL counts on each concurrent route trace', async () => {
  const { sqlite, d1 } = sqliteD1('CREATE TABLE message(id TEXT PRIMARY KEY, thread TEXT, role TEXT, content TEXT)')
  const binding = withD1LimitAlarms(d1, createProductLimitAlarms({ product: 'phase-timing-integration' }))
  const store: ChatTurnMessageStore = {
    async listMessages(threadId) {
      return (await binding.prepare('SELECT id, role, content FROM message WHERE thread = ?').bind(threadId)
        .all<{ id: string; role: 'user' | 'assistant'; content: string }>()).results
    },
    async appendMessage(input) {
      const id = input.id ?? crypto.randomUUID()
      await binding.prepare('INSERT INTO message(id, thread, role, content) VALUES (?, ?, ?, ?)')
        .bind(id, input.threadId, input.role, input.content).run()
      return { id }
    },
  }
  const snapshots: TurnTraceSnapshot[] = [], observed: TurnPhaseTiming[] = [], pending: Promise<unknown>[] = []
  const seamFloors: Record<string, number> = {}
  const routes = createChatTurnRoutes({
    projectId: 'phase-timing', store, turnStore: createMemoryTurnEventStore(),
    authorize: async ({ trace, span }) => {
      if (!trace) throw new Error('The route did not provide its trace')
      const timing = trace.timing({ prefix: 'product', kinds: { left: 'network', right: 'network', setup: 'persist' } })
      timing.within(span)
      await Promise.all([
        timing.track('left', binding.prepare('SELECT 1 AS n').bind().first()),
        timing.track('right', binding.prepare('SELECT 2 AS n').bind().first()),
      ])
      timing.mark('gates')
      return { ok: true as const, tenantId: 'workspace', userId: 'user', context: { timing, seamFloor: 0 } }
    },
    beforeTurn: async ({ context }, seam) => {
      context.timing.mark('admission')
      // Actual elapsed time separates the previous mark from the new seam's lower clock bound.
      await new Promise(resolve => setTimeout(resolve, 5))
      context.seamFloor = Date.now()
      context.timing.within(seam?.span)
      await binding.prepare('SELECT 3 AS n').bind().first()
      context.timing.mark('setup')
    },
    produce: () => ({ stream: (async function* () { yield { type: 'text' as const, text: 'One answer.' } })(), finalText: () => 'One answer.' }),
    lifecycle: { onTurnComplete: ({ context, executionId }) => {
      observed.push(context.timing); seamFloors[executionId] = context.seamFloor
    } },
    turnTrace: { sink: snapshot => { snapshots.push(snapshot) } },
  })
  try {
    const responses = await Promise.all(['first', 'second'].map(threadId => routes.turn(new Request('https://app.test/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId, content: 'Record phases.' }),
    }), { waitUntil: work => { pending.push(work) } })))
    for (const response of responses) expect(response.status).toBe(200)
    await Promise.all(responses.map(response => response.text()))
    await Promise.all(pending)
    expect(snapshots).toHaveLength(2)
    expect(observed).toHaveLength(2)
    expect(new Set(snapshots.map(snapshot => snapshot.rootSpanId)).size).toBe(2)
    for (const timing of observed) {
      expect(timing.queries().gates).toBe(2)
      expect(timing.queries().setup).toBe(1)
      expect(Object.keys(timing.concurrent()).sort()).toEqual(['left', 'right'])
      expect(timing.phases().setup).toBeGreaterThanOrEqual(0)
    }
    for (const snapshot of snapshots) {
      expect(snapshot.summary.d1Queries).toBeGreaterThanOrEqual(6)
      const setup = snapshot.spans.filter(span => span.name === 'product.setup')
      expect(setup).toHaveLength(1)
      expect(setup[0]!.kind).toBe('persist')
      const parent = snapshot.spans.find(span => span.spanId === setup[0]!.parentSpanId)
      expect(parent?.name).toBe('admission.before_turn')
      expect(setup[0]!.startMs).toBeGreaterThanOrEqual(parent!.startMs)
      expect(setup[0]!.startMs).toBeGreaterThanOrEqual(seamFloors[snapshot.executionId]!)
      for (const name of ['left', 'right']) {
        const work = snapshot.spans.find(span => span.name === `product.${name}`)!
        expect(work.kind).toBe('network')
        expect(work.parentSpanId).toBe(snapshot.rootSpanId)
      }
    }
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM message').get()?.n).toBe(4)
  } finally { sqlite.close() }
})
