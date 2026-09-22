import { describe, expect, it, vi } from 'vitest'

import {
  createChatTurnRoutes,
  type ChatTurnMessageStore,
  type ChatTurnProduceArgs,
  type ChatTurnRouteProducer,
} from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'

interface StoredMessage {
  id: string
  threadId: string
  role: 'user' | 'assistant'
  content: string
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  return { promise: new Promise<void>((done) => { resolve = done }), resolve }
}

function request(): Request {
  return new Request('http://app.test/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: 'thread-handoff', content: 'run natively' }),
  })
}

async function readLines(body: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
  return (await new Response(body).text())
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('createChatTurnRoutes — durable completion handoff', () => {
  it('leaves settlement to the registered durable owner while continuing live projection', async () => {
    const rows: StoredMessage[] = []
    const assistantDraftWriteStarted = deferred()
    const releaseAssistantDraftWrite = deferred()
    let nextId = 0
    const store: ChatTurnMessageStore = {
      async listMessages(threadId) {
        return rows.filter((row) => row.threadId === threadId)
      },
      async appendMessage(input) {
        const row: StoredMessage = {
          id: input.id ?? `m${++nextId}`,
          threadId: input.threadId,
          role: input.role,
          content: input.content,
        }
        rows.push(row)
        if (row.role === 'assistant') {
          assistantDraftWriteStarted.resolve()
          await releaseAssistantDraftWrite.promise
        }
        return row
      },
      async updateMessage(id, patch) {
        const row = rows.find((candidate) => candidate.id === id)
        if (row && patch.content !== undefined) row.content = patch.content
        return row ?? null
      },
      async deleteMessage(id) {
        const index = rows.findIndex((row) => row.id === id)
        if (index >= 0) rows.splice(index, 1)
        return null
      },
    }
    const turnStore = createMemoryTurnEventStore()
    const pending: Promise<unknown>[] = []
    let nativeDispatched = false
    let handoffStarted!: () => void
    const handoffStartedPromise = new Promise<void>((resolve) => { handoffStarted = resolve })
    const observed: string[] = []
    const lifecycle = { start: 0, complete: 0, error: 0 }
    const release = vi.fn()
    const onTurnComplete = vi.fn()

    const routes = createChatTurnRoutes({
      projectId: 'handoff-test',
      authorize: async () => ({ ok: true as const, tenantId: 'tenant-1', userId: 'user-1', context: undefined }),
      store,
      turnStore,
      turnLock: {
        acquire: () => ({ acquired: true as const, handle: 'route-lock' }),
        release,
      },
      lifecycle: {
        onTurnStart: () => { lifecycle.start += 1 },
        onTurnComplete: () => { lifecycle.complete += 1 },
        onTurnError: () => { lifecycle.error += 1 },
      },
      onTurnComplete,
      onEvent: (event) => { observed.push(event.type) },
      produce: (args: ChatTurnProduceArgs<void>): ChatTurnRouteProducer => ({
        stream: (async function* () {
          yield { type: 'text', text: 'route draft' }
          await assistantDraftWriteStarted.promise
          handoffStarted()
          await args.handoffCompletion!()

          // This is the external Workflow settlement that was registered before
          // handoff. It must survive every later route event and EOF.
          const assistant = rows.find((row) => row.role === 'assistant')!
          await store.updateMessage!(assistant.id, { content: 'workflow final' })
          await turnStore.setStatus(args.turnStreamId, 'complete', 'thread-handoff')
          nativeDispatched = true

          // Advance past the tap's lease interval. A still-attached tap would
          // renew `running` as it projects this event and overwrite the
          // Workflow's terminal status.
          const future = Date.now() + 31_000
          const clock = vi.spyOn(Date, 'now').mockReturnValue(future)
          yield { type: 'text', text: 'live after handoff' }
          clock.mockRestore()
          yield { type: 'error', data: { message: 'native observer ended' } }
        })(),
        finalText: () => 'route final that must not persist',
      }),
    })

    const response = await routes.turn(request(), {
      waitUntil: (work) => void pending.push(work),
    })
    const linesPromise = readLines(response.body!)
    await handoffStartedPromise

    // Handoff cannot return or dispatch native work until the outstanding
    // route draft has flushed and closed.
    expect(nativeDispatched).toBe(false)
    releaseAssistantDraftWrite.resolve()

    const lines = await linesPromise
    await Promise.all(pending)
    const turnId = response.headers.get('x-turn-id')!

    expect(lines.some((line) => line.type === 'text' && line.text === 'live after handoff')).toBe(true)
    expect(observed).toContain('error')
    expect(await turnStore.getStatus(turnId)).toBe('complete')
    expect(await turnStore.listRunning?.('thread-handoff')).toEqual([])
    expect(rows.filter((row) => row.role === 'assistant')).toEqual([
      expect.objectContaining({ content: 'workflow final' }),
    ])
    expect(lifecycle).toEqual({ start: 1, complete: 0, error: 0 })
    expect(onTurnComplete).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })
})
