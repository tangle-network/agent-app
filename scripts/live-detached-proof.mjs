// LIVE: the autonomous lane end-to-end against production — a real box, a
// detached-style turn projected through runDetachedTurn with the persist seam,
// finishing as a durable assistant row. Failover assertions live in
// tests/chat-routes/detached-failover.live.test.ts; this run proves the lane
// itself while the platform model-substitution incident blocks failover firing.
import { SandboxClient } from '@tangle-network/sandbox'
import { runDetachedTurn } from '../src/chat-routes/index.ts'
import { createChatTables } from '../src/chat-store/schema.ts'
import { createChatStore } from '../src/chat-store/store.ts'
import { createMemoryTurnEventStore } from '../src/stream/index.ts'
import { openDatabase, workspacesTable } from '../tests/teams/db-helper.ts'

const client = new SandboxClient({
  apiKey: process.env.SANDBOX_API_KEY,
  baseUrl: process.env.SANDBOX_API_URL ?? 'https://sandbox.tangle.tools',
})
const box = await client.create({ name: `detached-lane-proof-${Date.now()}`.slice(0, 63) })
console.log(`[live] box ${box.id}`)

const tables = createChatTables({ workspaceTable: workspacesTable })
const db = openDatabase([workspacesTable, tables.threads, tables.messages])
await db.insert(workspacesTable).values([{ id: 'ws1', organizationId: 'org1', name: 'WS' }])
const store = createChatStore(db, tables)
const thread = await store.createThread({ workspaceId: 'ws1', title: 'detached lane' })
const turnId = `detached-lane-${Date.now()}`
const turnStore = createMemoryTurnEventStore()

const result = await runDetachedTurn({
  store: turnStore,
  turnId,
  scopeId: thread.id,
  model: 'gpt-5-mini',
  openEvents: ({ model, attempt }) => {
    console.log(`[live] open attempt ${attempt} -> ${model} at ${new Date().toISOString()}`)
    return box.streamPrompt('Name the capital of Italy in one short sentence.', {
      model,
      sessionId: `${thread.id}-${attempt}`,
    })
  },
  persist: { store, threadId: thread.id },
  declineInteraction: async () => {},
  log: (m) => console.log(`[live] ${m}`),
})

const rows = await store.listMessages(thread.id)
const assistant = rows.find((r) => r.role === 'assistant')
const buffered = await turnStore.read(turnId, 0)
console.log(
  JSON.stringify(
    {
      state: result.state,
      cached: result.cached,
      text: result.text.slice(0, 100),
      model: result.model,
      usedModelFallback: result.usedModelFallback,
      messageId: result.messageId,
      rowModel: assistant?.model ?? null,
      rowContent: (assistant?.content ?? '').slice(0, 100),
      bufferedTurnEvents: buffered.length,
      turnStatus: await turnStore.getStatus(turnId),
      finishedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
)
