import { expect, it } from 'vitest'
import { text } from 'drizzle-orm/sqlite-core'
import { createChatTurnRoutes, type ChatTurnMessageStore } from '../../src/chat-routes/index'
import { createChatTables, createChatStore, type ChatDatabase } from '../../src/chat-store/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { openDatabase } from '../teams/db-helper'

it('merges product-declared metadata atomically through a real SQLite turn and fences stale completion', async () => {
  const tables = createChatTables({ messageExtraColumns: {
    metadata: text('product_turn_metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  } })
  const database = openDatabase([tables.threads, tables.messages])
  const store = createChatStore(database as unknown as ChatDatabase, tables)
  const thread = await store.createThread({ workspaceId: 'workspace', title: 'Turn metadata' })
  const pending: Promise<unknown>[] = []
  let messageId: string | undefined, staleUpdate: unknown
  const routes = createChatTurnRoutes({
    projectId: 'metadata-route', store: store as unknown as ChatTurnMessageStore,
    turnStore: createMemoryTurnEventStore(),
    authorize: async () => ({ ok: true as const, tenantId: 'workspace', userId: 'user', context: undefined }),
    beforeTurn: async args => {
      messageId = args.userMessageId ?? undefined
      if (!messageId) throw new Error('The route must insert its user row before metadata is written')
      await store.patchMessageMetadata(messageId, { responseStatus: 'streaming', executionId: 'current',
        failureMessage: 'Previous failure', product: { keep: 'owned', remove: 'old' } })
      await Promise.all([
        store.patchMessageMetadata(messageId, { billing: { reservation: 'held' } }),
        store.patchMessageMetadata(messageId, { product: { added: true } }),
      ])
    },
    produce: () => ({ stream: (async function* () { yield { type: 'text' as const, text: 'One answer.' } })(), finalText: () => 'One answer.' }),
    onTurnComplete: async () => {
      staleUpdate = await store.patchMessageMetadata(messageId!, { responseStatus: 'failed' }, { executionId: 'superseded' })
      await store.patchMessageMetadata(messageId!, { responseStatus: 'answered', failureMessage: null,
        product: { remove: null } }, { executionId: 'current', responseStatus: 'streaming' })
    },
  })
  try {
    const response = await routes.turn(new Request('https://app.test/chat', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: thread.id, content: 'Answer once.' }),
    }), { waitUntil: work => { pending.push(work) } })
    expect(response.status).toBe(200)
    await response.text()
    await Promise.all(pending)
    expect(staleUpdate).toBeNull()
    expect((await store.getMessage(messageId!))?.metadata).toEqual({ responseStatus: 'answered', executionId: 'current',
      product: { keep: 'owned', added: true }, billing: { reservation: 'held' } })
    const assistant = (await store.listMessages(thread.id)).filter(row => row.role === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0]!.content).toBe('One answer.')
  } finally { database.$client.close() }
})
