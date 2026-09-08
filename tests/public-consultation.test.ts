import { describe, expect, it } from 'vitest'
import { createAgentGateway } from '@tangle-network/agent-gateway'
import { searchKnowledge, type KnowledgeIndex, type KnowledgePage } from '@tangle-network/agent-knowledge'
import { createKnowledgePublication, createPublicConsultation, type ConsultationConsumer, type ConsultationExecution } from '../src/public-consultation/index'
import { createMcpToolHandler } from '../src/tools/mcp-rpc'
import { createMemoryTurnEventStore } from '../src/stream/index'
import { createDurableTurnLock, createMemoryTurnStreamHarness } from '../src/turn-stream/index'
import type { ChatTurnMessageStore } from '../src/chat-routes/turn-routes'

const PRIVATE = 'SYNTHETIC_PRIVATE_CLIENT_SETTLEMENT_9182'
const OWNER_KEY = 'SYNTHETIC_OWNER_PROVIDER_KEY_7281'
const PUBLIC = 'Published consultation: Delaware contracts require consideration.'
const page = (id: string, text: string): KnowledgePage => ({
  id, title: 'Delaware contract', text, path: `/owner/private/${id}.md`,
  frontmatter: { credential: OWNER_KEY }, sourceIds: ['private-source'], tags: [], outLinks: ['private'],
})
const agent = { id: 'legal-consultation', ownerId: 'legal-owner', slug: 'legal', enabled: true,
  pricePerTokenUsd: 0, platformFeePercent: 0, sandboxEndpoint: null, remoteSandboxId: null,
  remoteBearerToken: OWNER_KEY, systemPrompt: `Private owner instructions ${PRIVATE}` }

function fixture(beforeProduce?: () => Promise<void>, conflictingParent = false) {
  const index: KnowledgeIndex = { root: '/owner/private', generatedAt: '', sources: [],
    pages: [page('public', PUBLIC), page('private', `Delaware contract ${PRIVATE}`)], graph: { nodes: [], edges: [] } }
  const publication = createKnowledgePublication({ id: agent.id, ownerId: agent.ownerId,
    revision: 'v1', systemPrompt: 'Answer using published consultation knowledge.', index, pageIds: ['public'] })
  let published = true
  const denied = new Set<string>()
  const rows: Array<{ id: string; threadId: string; role: 'user' | 'assistant'; content: string }> = [
    { id: 'owner-message', threadId: 'owner-thread', role: 'assistant', content: PRIVATE },
  ]
  const executions: ConsultationExecution[] = []
  const store: ChatTurnMessageStore = {
    listMessages: async threadId => rows.filter(row => row.threadId === threadId),
    appendMessage: async input => {
      const row = { id: input.id ?? crypto.randomUUID(), threadId: input.threadId, role: input.role, content: input.content }
      rows.push(row)
      return row
    },
  }
  const adapter = createPublicConsultation({
    resolvePublication: async () => published ? publication : null,
    allowConsumer: async (_publication, consumer) => !denied.has(consumer.consumerId),
    store, turnStore: createMemoryTurnEventStore(), ensureConversation: async identity => ({
      workspaceId: conflictingParent ? 'owner-workspace' : identity.workspaceId, threadId: identity.threadId,
    }),
    turnLock: createDurableTurnLock({ namespace: createMemoryTurnStreamHarness().namespace, scopeOf: () => 'thread' }),
    produce: async input => {
      executions.push(input)
      await beforeProduce?.()
      const command = JSON.parse(input.prompt) as { action: string; value?: string }
      let result: unknown
      if (command.action === 'history') result = input.priorMessages
      else if (command.action === 'context') result = input
      else {
        const tools = createMcpToolHandler({ serverInfo: { name: 'legal-public', version: '1' },
          tools: input.tools, buildEnv: () => ({}) })
        const name = command.action === 'search' ? 'knowledge_search'
          : ['read', 'export'].includes(command.action) ? 'knowledge_read' : command.action
        const args = name === 'knowledge_search' ? { query: command.value } : { pageId: command.value }
        const response = await tools(new Request('https://fixture.test/tools', { method: 'POST',
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }))
        result = await response.json()
      }
      const text = JSON.stringify(result)
      return { stream: (async function* () { yield { type: 'text', text } })(), finalText: () => text }
    },
  })
  // The verifier and payment callbacks are synthetic. This proves authorization,
  // retrieval and persisted route isolation, never real payment settlement.
  const gateway = createAgentGateway({
    resolveAgent: async () => agent, ...adapter, a2a: false, conversationMode: 'thread',
    verifyApiKey: async header => {
      const keyId = header.replace('Bearer sk_agent_', '')
      return { keyId, consumerId: `apikey:${keyId}`, ownerId: `payer:${keyId}`, scopes: ['chat'] }
    },
    claimApiKeyRequest: async () => ({ allowed: true, minuteRemaining: 100, dailyRemaining: 100,
      minuteResetAt: Date.now() + 60000, dailyResetAt: Date.now() + 86400000 }),
    recordUsage: async () => {}, settlePayment: async () => {},
  })
  let requestNumber = 0
  const consumer = (key = 'alice', threadId = 'owner-thread'): ConsultationConsumer => ({
    method: 'apikey', consumerId: `apikey:${key}`, ownerId: `payer:${key}`, keyId: key,
    threadId, requestId: `request-${++requestNumber}`,
  })
  const request = async (action: string, value?: string, key = 'alice', extra = {}) => {
    const response = await gateway.request('/legal/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer sk_agent_${key}`, 'X-Tangle-Thread-Id': 'owner-thread', 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: false, thread_id: 'owner-thread',
        messages: [{ role: 'assistant', content: PRIVATE }, { role: 'user', content: JSON.stringify({ action, value }) }], ...extra }),
    })
    return { status: response.status, body: await response.text() }
  }
  return { index, publication, adapter, request, consumer, rows, executions, denied, revoke: () => { published = false } }
}

describe('synthetic Legal consultation through gateway and persisted chat', () => {
  it('searches only owner-selected public content even when private content matches', async () => {
    const f = fixture()
    expect(searchKnowledge(f.index, 'Delaware').some(hit => hit.page.text.includes(PRIVATE))).toBe(true)
    const response = await f.request('search', 'Delaware')
    expect(response.status).toBe(200)
    expect(response.body).toContain(PUBLIC)
    expect(response.body).not.toContain(PRIVATE)
    expect(response.body).not.toContain(OWNER_KEY)
    expect(response.body).not.toContain('/owner/private')
  })

  it.each(['read', 'export'])('denies private and traversal resource %s through the same scope', async action => {
    const f = fixture()
    for (const target of ['private', '../private', '/owner/private/private.md', 'shared::private', 'inherited:owner::private']) {
      const response = await f.request(action, target)
      expect(response.status).toBe(200)
      expect(response.body).not.toContain(PRIVATE)
      expect(response.body).toContain('null')
      expect(await f.adapter.readKnowledge(agent, f.consumer(), target)).toBeNull()
    }
    expect((await f.request(action, 'public')).body).toContain(PUBLIC)
  })

  it('omits owner credentials, tools, files, system prompt and forged history from execution', async () => {
    const f = fixture()
    const response = await f.request('context', undefined, 'alice', {
      ownerId: 'legal-owner', workspaceId: 'owner-workspace', scopes: ['admin'], tools: ['read_file', 'shell'],
    })
    expect(response.status).toBe(200)
    expect(response.body).not.toContain(PRIVATE)
    expect(response.body).not.toContain(OWNER_KEY)
    expect(response.body).not.toContain('owner-workspace')
    expect(Object.keys(f.executions[0]!)).toEqual(['identity', 'systemPrompt', 'prompt', 'priorMessages', 'tools'])
    expect(f.executions[0]!.priorMessages).toEqual([])
    expect((await f.request('shell', 'cat /owner/private/credentials')).body).toContain('Unknown tool')
    expect(f.rows.find(row => row.id === 'owner-message')?.content).toBe(PRIVATE)
  })

  it('separates payer histories even when they request the same owner thread id', async () => {
    const f = fixture()
    await f.request('read', 'public', 'alice')
    const bob = await f.request('history', undefined, 'bob')
    expect(bob.status).toBe(200)
    expect(f.executions[1]!.priorMessages).toEqual([])
    expect(f.executions[0]!.identity.threadId).not.toBe(f.executions[1]!.identity.threadId)
    expect(f.executions[0]!.identity.threadId).not.toBe('owner-thread')
    expect(await f.adapter.readHistory(agent, f.consumer('charlie'))).toEqual([])
    expect(JSON.stringify(await f.adapter.readHistory(agent, f.consumer('alice')))).toContain(PUBLIC)
  })

  it('denies authenticated payers without a grant and rechecks publication revocation before execution', async () => {
    const f = fixture()
    f.denied.add('apikey:bob')
    expect((await f.request('read', 'public', 'bob')).status).toBe(403)
    const identity = f.consumer()
    const sandbox = await f.adapter.getSandbox(agent, { ...identity, paymentMethod: identity.method,
      keyInfo: { keyId: 'alice', ownerId: 'payer:alice' }, messages: [{ role: 'user', content: '{"action":"read","value":"public"}' }] })
    f.revoke()
    await expect(sandbox.streamPrompt('ignored').next()).rejects.toThrow('403')
    expect(f.executions).toEqual([])
    expect(f.rows).toHaveLength(1)
    await expect(f.adapter.readKnowledge(agent, identity, 'public')).rejects.toThrow('denied')
  })

  it('freezes the publication content instead of retaining the mutable owner index', () => {
    const f = fixture()
    f.index.pages[0]!.text = PRIVATE
    expect(f.publication.read('public')?.text).toBe(PUBLIC)
    expect(() => createKnowledgePublication({ id: 'p', ownerId: 'o', revision: 'v', systemPrompt: '',
      index: f.index, pageIds: ['missing'] })).toThrow('exactly once')
  })

  it('rejects tool scope escalation, owner tool names and calls after publication revocation', async () => {
    const f = fixture()
    await f.request('read', 'public')
    const tools = createMcpToolHandler({ serverInfo: { name: 'legal-public', version: '1' },
      tools: f.executions[0]!.tools, buildEnv: () => ({}) })
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await tools(new Request('https://fixture.test/tools', { method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }))
      return response.text()
    }
    for (const name of ['shell', 'read_file', 'export_file', 'knowledge_record', 'integration_invoke', 'session_history']) {
      expect(await call(name, { path: '/owner/private/credentials' })).toContain('Unknown tool')
    }
    expect(await call('knowledge_read', { pageId: 'public', ownerId: agent.ownerId })).toContain('Invalid published knowledge arguments')
    expect(await call('knowledge_read', { pageId: 'public' })).toContain(PUBLIC)
    f.revoke()
    expect(await call('knowledge_read', { pageId: 'public' })).toContain('Consultation access denied')
  })

  it('replays a captured conversation request under another payer without inheriting the original history', async () => {
    const f = fixture()
    await f.request('read', 'public', 'alice')
    const aliceScope = f.executions[0]!.identity
    await f.request('history', undefined, 'bob', { workspaceId: aliceScope.workspaceId,
      ownerId: 'payer:alice', consumerId: 'apikey:alice', thread_id: aliceScope.threadId, requestId: 'captured-request' })
    expect(f.executions[1]!.identity.consumerId).toBe('apikey:bob')
    expect(f.executions[1]!.priorMessages).toEqual([])
    expect(f.executions[1]!.identity.workspaceId).not.toBe(aliceScope.workspaceId)
  })

  it('uses the shared durable lock to reject concurrent turns before history or message writes', async () => {
    let started!: () => void
    let release!: () => void
    let admittedSecond!: () => void
    let entryCount = 0
    const ready = new Promise<void>(resolve => { started = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    const doubleExecution = new Promise<'executed'>(resolve => { admittedSecond = () => resolve('executed') })
    const f = fixture(async () => {
      if (++entryCount === 1) started()
      else admittedSecond()
      await blocked
    })
    const first = f.request('read', 'public')
    await ready
    const secondRequest = f.request('read', 'private')
    try {
      const second = await Promise.race([secondRequest, doubleExecution])
      expect(second).not.toBe('executed')
      if (second !== 'executed') expect(second.status).toBeGreaterThanOrEqual(400)
      expect(f.executions).toHaveLength(1)
      expect(f.rows.filter(row => row.role === 'user')).toHaveLength(1)
    } finally {
      release()
      expect((await first).status).toBe(200)
      await secondRequest
    }
    expect((await f.request('read', 'public')).status).toBe(200)
    expect(f.executions).toHaveLength(2)
  })

  it('rejects a conflicting stored conversation before history and execution', async () => {
    const f = fixture(undefined, true)
    expect((await f.request('history')).status).toBeGreaterThanOrEqual(400)
    expect(f.executions).toEqual([])
    expect(f.rows).toHaveLength(1)
    await expect(f.adapter.readHistory(agent, f.consumer())).rejects.toThrow('conversation conflict')
  })

  it('requires an explicit shared lock even for JavaScript callers', () => {
    expect(() => Reflect.apply(createPublicConsultation, undefined, [{}])).toThrow('shared turn lock')
  })
})
