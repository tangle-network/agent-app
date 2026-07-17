import { describe, expect, it } from 'vitest'

// Force the turn engine to throw SYNCHRONOUSLY after the route has already
// fired `onTurnStart` — the pre-drain failure path. The drain (which normally
// settles the lifecycle) never runs here, so this proves the route's own
// `catch` settles it: `onTurnError` fires and the turn lock is released.
import { vi } from 'vitest'
vi.mock('@tangle-network/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tangle-network/agent-runtime')>()
  return {
    ...actual,
    handleChatTurn: () => {
      throw new Error('engine boom')
    },
  }
})

import { createChatTurnRoutes, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'

function memoryStore(): ChatTurnMessageStore {
  const rows: Array<Record<string, unknown>> = []
  let id = 1
  return {
    async listMessages() {
      return rows as never
    },
    async appendMessage(input) {
      rows.push({ id: `m${id++}`, ...input })
      return input
    },
  }
}

describe('createChatTurnRoutes — synchronous engine throw', () => {
  it('settles the lifecycle (onTurnError) and releases the lock even when the engine throws after onTurnStart', async () => {
    const events: string[] = []
    const lockOrder: string[] = []
    const routes = createChatTurnRoutes({
      projectId: 'sync-throw',
      authorize: async () => ({ ok: true, tenantId: 'ws', userId: 'u', context: undefined }),
      store: memoryStore(),
      turnStore: createMemoryTurnEventStore(),
      produce: () => ({
        stream: (async function* () {})(),
        finalText: () => '',
      }),
      lifecycle: {
        onTurnStart: () => { events.push('start') },
        onTurnComplete: () => { events.push('complete') },
        onTurnError: () => { events.push('error') },
      },
      turnLock: {
        acquire: () => { lockOrder.push('acquire'); return { acquired: true as const, handle: 'h' } },
        release: (handle) => { lockOrder.push(`release:${String(handle)}`) },
      },
      log: () => {},
    })

    const req = new Request('http://app.test/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 't-1', content: 'hi' }),
    })

    await expect(routes.turn(req)).rejects.toThrow('engine boom')
    // onTurnStart fired, then the sync throw settled with onTurnError — never a
    // dangling "started but unsettled" span, and never a false complete.
    expect(events).toEqual(['start', 'error'])
    // The lock acquired before the turn is released on the throw.
    expect(lockOrder).toEqual(['acquire', 'release:h'])
  })
})
