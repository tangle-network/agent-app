/**
 * A product's producer spends time of its own before its first event (keys, reads, a box it resolves itself) and after
 * its last (the cleanup its stream runs before returning: revocations, a charge). On Tax that was 745 ms and 1,382 ms
 * of a 12.6 s Router turn with no span. The turn's trace names both, so its coverage holds.
 */
import { expect, it } from 'vitest'
import { createChatTurnRoutes, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import type { TurnTraceSnapshot } from '../../src/turn-trace/index'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

it('names the producer setup before its first event and its settle after its last', async () => {
  const rows: Array<{ id: string; role: 'user' | 'assistant'; content: string }> = []
  const store: ChatTurnMessageStore = {
    async listMessages() { return rows },
    async appendMessage(input) { rows.push({ id: String(rows.length), role: input.role, content: String(input.content ?? '') }); return { id: String(rows.length - 1) } },
  }
  const snapshots: TurnTraceSnapshot[] = []
  const pending: Promise<unknown>[] = []
  const routes = createChatTurnRoutes({
    projectId: 'producer-gaps', store, turnStore: createMemoryTurnEventStore(),
    authorize: async () => ({ ok: true as const, tenantId: 'workspace', userId: 'member', context: undefined }),
    turnTrace: { sink: (snapshot) => { snapshots.push(snapshot) } },
    // Shaped like Tax's: the stream is lazy, so its setup runs on the first pull; its cleanup runs in `finally`.
    produce: () => ({
      stream: (async function* () {
        await sleep(120)
        try {
          yield { type: 'text' as const, text: 'Filed.' }
        } finally {
          await sleep(120)
        }
      })(),
      finalText: () => 'Filed.',
    }),
  })
  const response = await routes.turn(new Request('https://app.test/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: 'thread-1', content: 'File it.' }),
  }), { waitUntil: (work) => { pending.push(work) } })
  await response.text()
  await Promise.all(pending)
  const [snapshot] = snapshots
  const span = (name: string) => snapshot!.spans.find((s) => s.name === name)
  const setup = span('produce.setup')
  const settle = span('produce.settle')
  expect(setup && setup.endMs - setup.startMs).toBeGreaterThanOrEqual(110)
  expect(settle && settle.endMs - settle.startMs).toBeGreaterThanOrEqual(110)
  // Setup starts where admission.produce ends; settle ends before the assistant row is written.
  expect(setup!.startMs).toBeGreaterThanOrEqual(span('admission.produce')!.endMs)
  expect(settle!.endMs).toBeLessThanOrEqual(span('persist.assistant')!.startMs)
  expect(snapshot!.summary.largestGapMs).toBeLessThan(60)
  expect(snapshot!.summary.coveragePct).toBeGreaterThanOrEqual(80)
})
