/**
 * A turn addressed to agents by mention answers once per agent, one after
 * another in mention order, as one assistant row whose parts carry a speaker
 * part before each answer, through a real SQLite store and the real route.
 */
import { describe, expect, it } from 'vitest'
import { createChatTurnRoutes, type ChatTurnMessageStore, type ChatTurnAgentTarget } from '../../src/chat-routes/index'
import { createChatTables, createChatStore, type ChatDatabase } from '../../src/chat-store/index'
import { createMemoryTurnEventStore } from '../../src/stream/index'
import { expandSpeakerRows } from '../../src/web/index'
import { openDatabase } from '../teams/db-helper'

const ROSTER: ChatTurnAgentTarget[] = [
  { id: 'ap_research', handle: 'research-lead', name: 'Research Lead', profile: { name: 'Research Lead', prompt: { systemPrompt: 'Find risks.' } } },
  { id: 'ap_writer', handle: 'writer', name: 'Writer', profile: { name: 'Writer', prompt: { systemPrompt: 'Draft copy.' } } },
]
const mention = (agent: ChatTurnAgentTarget) => ({ kind: 'agent', agentId: agent.id, handle: agent.handle, name: agent.name })

function harness(options: { agents?: boolean } = {}) {
  const tables = createChatTables()
  const database = openDatabase([tables.threads, tables.messages])
  const store = createChatStore(database as unknown as ChatDatabase, tables)
  const produced: Array<{ agent?: string; profile?: string; agents?: string[] }> = []
  const routes = createChatTurnRoutes({
    projectId: 'agent-fanout', store: store as unknown as ChatTurnMessageStore,
    turnStore: createMemoryTurnEventStore(),
    authorize: async () => ({ ok: true as const, tenantId: 'workspace', userId: 'user', context: undefined }),
    ...(options.agents === false ? {} : {
      agents: { resolve: async ({ mentions }) => ROSTER.filter((agent) => mentions.some((m) => m.agentId === agent.id)) },
    }),
    produce: (args) => {
      produced.push({ agent: args.agent?.id, profile: args.agent?.profile?.name, agents: args.agents?.map((a) => a.id) })
      const text = args.agent ? `${args.agent.name} answers.` : 'The thread agent answers.'
      return {
        stream: (async function* () { yield { type: 'text' as const, text } })(),
        finalText: () => text,
        assistantParts: () => [{ type: 'text', text }],
        usage: () => ({ inputTokens: 10, outputTokens: 5 }),
      }
    },
  })
  return { routes, store, produced, close: () => database.$client.close() }
}

async function turn(routes: ReturnType<typeof harness>['routes'], threadId: string, body: Record<string, unknown>) {
  const pending: Promise<unknown>[] = []
  const response = await routes.turn(new Request('https://app.test/chat', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId, ...body }) }),
    { waitUntil: (work) => { pending.push(work) } })
  const text = await response.text()
  await Promise.all(pending)
  return { response, text }
}

describe('a turn addressed to agents', () => {
  it('answers once per mentioned agent, in mention order, as one row with a speaker part before each', async () => {
    const h = harness()
    try {
      const thread = await h.store.createThread({ workspaceId: 'workspace', title: 'Launch' })
      const { response, text } = await turn(h.routes, thread.id, {
        content: '@writer @research-lead plan the launch', mentions: [mention(ROSTER[1]!), mention(ROSTER[0]!)],
      })
      expect(response.status).toBe(200)
      // The order typed, not the roster's order; each producer runs as its agent.
      expect(h.produced).toEqual([
        { agent: 'ap_writer', profile: 'Writer', agents: ['ap_writer', 'ap_research'] },
        { agent: 'ap_research', profile: 'Research Lead', agents: ['ap_writer', 'ap_research'] },
      ])
      // The live stream announces each responder before their text.
      const events = text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
        .map((line) => (line.kind === 'event' ? line.event : line) as Record<string, unknown>)
      const order = events.filter((e) => e.type === 'speaker' || e.type === 'text').map((e) => e.type === 'speaker' ? `speaker:${e.id}` : `text:${e.text}`)
      expect(order).toEqual(['speaker:ap_writer', 'text:Writer answers.', 'speaker:ap_research', 'text:Research Lead answers.'])
      const rows = await h.store.listMessages(thread.id)
      const assistant = rows.filter((row) => row.role === 'assistant')
      expect(assistant).toHaveLength(1)
      expect(assistant[0]!.content).toBe('Writer answers.\n\nResearch Lead answers.')
      expect(assistant[0]!.parts).toEqual([
        { type: 'speaker', id: 'ap_writer', name: 'Writer', handle: 'writer' },
        { type: 'text', text: 'Writer answers.' },
        { type: 'speaker', id: 'ap_research', name: 'Research Lead', handle: 'research-lead' },
        { type: 'text', text: 'Research Lead answers.' },
      ])
      // The user row keeps the mentions it was sent with, by stable id.
      const user = rows.find((row) => row.role === 'user')!
      expect(user.parts).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'mention', mentionKind: 'agent', path: 'writer', agentId: 'ap_writer' }),
      ]))
      // A transcript draws two answers under two authors from the one row.
      const drawn = expandSpeakerRows(rows.map((row) => ({ id: row.id, role: row.role, content: row.content, parts: row.parts ?? [] })))
      expect(drawn.filter((row) => row.role === 'assistant').map((row) => row.author?.name)).toEqual(['Writer', 'Research Lead'])
    } finally { h.close() }
  })

  it('refuses a mention of an agent the workspace does not have, before any producer runs', async () => {
    const h = harness()
    try {
      const thread = await h.store.createThread({ workspaceId: 'workspace', title: 'Unknown' })
      const { response, text } = await turn(h.routes, thread.id, {
        content: '@ghost hello', mentions: [{ kind: 'agent', agentId: 'ap_ghost', handle: 'ghost', name: 'Ghost' }],
      })
      expect(response.status).toBe(400)
      expect(JSON.parse(text)).toMatchObject({ code: 'unknown_agent' })
      expect(h.produced).toEqual([])
      expect((await h.store.listMessages(thread.id)).filter((row) => row.role === 'assistant')).toEqual([])
    } finally { h.close() }
  })

  it('refuses agent mentions on a route that never configured agents, and still answers plain turns', async () => {
    const h = harness({ agents: false })
    try {
      const thread = await h.store.createThread({ workspaceId: 'workspace', title: 'Plain' })
      const refused = await turn(h.routes, thread.id, { content: '@writer hi', mentions: [mention(ROSTER[1]!)] })
      expect(refused.response.status).toBe(400)
      expect(JSON.parse(refused.text)).toMatchObject({ code: 'agents_unsupported' })
      const plain = await turn(h.routes, thread.id, { content: 'hi' })
      expect(plain.response.status).toBe(200)
      expect(h.produced).toEqual([{ agent: undefined, profile: undefined, agents: undefined }])
      const assistant = (await h.store.listMessages(thread.id)).filter((row) => row.role === 'assistant')
      expect(assistant.map((row) => row.content)).toEqual(['The thread agent answers.'])
    } finally { h.close() }
  })
})

describe('mentioned agents answer at the same time', () => {
  it('runs every responder at once and still presents them in the order typed', async () => {
    const tables = createChatTables()
    const database = openDatabase([tables.threads, tables.messages])
    const store = createChatStore(database as unknown as ChatDatabase, tables)
    const started: Record<string, number> = {}
    const finished: Record<string, number> = {}
    const routes = createChatTurnRoutes({
      projectId: 'agent-parallel', store: store as unknown as ChatTurnMessageStore,
      turnStore: createMemoryTurnEventStore(),
      authorize: async () => ({ ok: true as const, tenantId: 'workspace', userId: 'user', context: undefined }),
      agents: { resolve: async ({ mentions }) => ROSTER.filter((agent) => mentions.some((m) => m.agentId === agent.id)) },
      produce: (args) => {
        const id = args.agent!.id
        started[id] = performance.now()
        const text = `${args.agent!.name} answers.`
        return {
          stream: (async function* () {
            // Each responder takes 200 ms; in sequence that is 400 ms, at once it is about 200 ms.
            await new Promise((resolve) => setTimeout(resolve, 200))
            finished[id] = performance.now()
            yield { type: 'text' as const, text }
          })(),
          finalText: () => text,
        }
      },
    })
    try {
      const thread = await store.createThread({ workspaceId: 'workspace', title: 'Parallel' })
      const t0 = performance.now()
      const { response, text } = await turn(routes, thread.id, {
        content: '@writer @research-lead go', mentions: [mention(ROSTER[1]!), mention(ROSTER[0]!)],
      })
      const wall = performance.now() - t0
      expect(response.status).toBe(200)
      // The second responder started before the first finished.
      expect(started.ap_research).toBeLessThan(finished.ap_writer)
      expect(wall).toBeLessThan(380)
      const events = text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
        .map((line) => (line.kind === 'event' ? line.event : line) as Record<string, unknown>)
      expect(events.filter((e) => e.type === 'speaker').map((e) => e.id)).toEqual(['ap_writer', 'ap_research'])
      const assistant = (await store.listMessages(thread.id)).filter((row) => row.role === 'assistant')
      expect(assistant[0]!.content).toBe('Writer answers.\n\nResearch Lead answers.')
    } finally { database.$client.close() }
  })
})
