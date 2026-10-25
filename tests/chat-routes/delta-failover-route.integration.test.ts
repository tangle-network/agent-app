import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { createChatTurnRoutes, createSandboxChatProducer, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { sqliteD1 } from '../launch-invariants/sqlite-d1'

/** The raw HTTP source sends deltas without a cumulative part.text snapshot. */
// `disabled` is the Router's refusal of a model whose provider has no enabled credential (`403 provider_disabled`),
// as the box agent relays it (Tax 2026-10-25): model-scoped, so the chain must move on despite the 403.
it.each([
  { visible: true, disabled: false }, { visible: false, disabled: false }, { visible: false, disabled: true },
])('commits visible deltas before an outage (visible=$visible, disabled provider=$disabled)', async ({ visible, disabled }) => {
  const { sqlite, d1 } = sqliteD1('CREATE TABLE message(id TEXT PRIMARY KEY, thread TEXT, role TEXT, content TEXT)')
  const requested: string[] = [], pending: Promise<unknown>[] = []
  const server = createServer((request, response) => {
    const model = new URL(request.url!, 'http://source.test').searchParams.get('model')!
    requested.push(model)
    response.writeHead(200, { 'content-type': 'application/x-ndjson' })
    const emit = (event: unknown) => response.write(`${JSON.stringify(event)}\n`)
    emit({ type: 'start', data: { id: `execution-${model}` } })
    if (model === 'preferred') {
      if (visible) emit({ type: 'message.part.updated', data: { part: { type: 'text', id: 'answer' }, delta: 'Visible first.' } })
      emit({ type: 'error', data: disabled
        ? { status: 403, message: 'opencode execution failed: Tangle-funded openai inference is unavailable for "preferred": HTTP 403 provider_disabled' }
        : { errorCode: 'provider_inference_unavailable', message: 'Source unavailable.' } })
    } else {
      emit({ type: 'message.part.updated', data: { part: { type: 'text', id: 'answer' }, delta: 'Fallback answer.' } })
      emit({ type: 'result', data: { outcome: { type: 'completed' }, finalText: 'Fallback answer.', toolInvocations: [] } })
    }
    response.end()
  })
  const store: ChatTurnMessageStore = {
    async listMessages(threadId) {
      return (await d1.prepare('SELECT id, role, content FROM message WHERE thread = ? ORDER BY rowid').bind(threadId)
        .all<{ id: string; role: 'user' | 'assistant'; content: string }>()).results
    },
    async appendMessage(input) {
      const id = input.id ?? crypto.randomUUID()
      await d1.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').bind(id, input.threadId, input.role, input.content).run()
      return { id }
    },
  }
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const routes = createChatTurnRoutes({
    projectId: 'delta-failover', store, turnStore: createMemoryTurnEventStore(),
    authorize: async () => ({ ok: true as const, tenantId: 'workspace', userId: 'user', context: undefined }),
    produce: () => createSandboxChatProducer({ model: 'preferred', fallbackModels: ['fallback'], includeErrorText: false, log: () => {},
      openEvents: async ({ model }) => {
        const response = await fetch(`${baseUrl}/events?model=${model}`)
        if (!response.ok) throw new Error(`Source HTTP ${response.status}`)
        const lines = (await response.text()).trim().split('\n')
        return (async function* () { for (const line of lines) yield JSON.parse(line) as unknown })()
      },
    }),
  })
  try {
    const response = await routes.turn(new Request('https://app.test/chat', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: 'thread', content: 'Answer once.' }),
    }), { waitUntil: work => { pending.push(work) } })
    expect(response.status).toBe(200)
    const wire = await response.text()
    await Promise.all(pending)
    const rows = sqlite.prepare("SELECT content FROM message WHERE role = 'assistant'").all() as Array<{ content: string }>
    expect(rows).toHaveLength(1)
    if (visible) {
      // Negative calibration: the old snapshot-only probe requests fallback and loses this answer.
      expect(requested).toEqual(['preferred'])
      expect(rows[0]!.content).toBe('Visible first.')
      expect(wire).toContain('Visible first.')
      expect(wire).not.toContain('Fallback answer.')
    } else {
      expect(requested).toEqual(['preferred', 'fallback'])
      expect(rows[0]!.content).toBe('Fallback answer.')
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    sqlite.close()
  }
})
