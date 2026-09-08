import { searchKnowledge, type KnowledgeIndex, type KnowledgePage } from '@tangle-network/agent-knowledge'
import { createChatTurnRoutes, type ChatTurnLock, type ChatTurnMessageStore, type ChatTurnRouteProducer } from '../chat-routes/turn-routes'
import { streamChatRouteAsSandboxEvents } from '../chat-routes/gateway-adapter'
import type { TurnEventStore } from '../stream/turn-buffer'
import type { McpToolDefinition } from '../tools/mcp-rpc'

export interface PublishedKnowledgePage {
  readonly id: string
  readonly title: string
  readonly text: string
}

/** A server-created publication. Every selected page's complete text is public. */
export interface KnowledgePublication {
  readonly id: string
  readonly revision: string
  readonly ownerId: string
  readonly systemPrompt: string
  read(pageId: string): PublishedKnowledgePage | null
  search(query: string): PublishedKnowledgePage[]
}

/** Select content at publication time, before any payer or model input exists. */
export function createKnowledgePublication(input: {
  id: string
  revision: string
  ownerId: string
  systemPrompt: string
  index: KnowledgeIndex
  pageIds: readonly string[]
}): KnowledgePublication {
  for (const value of [input.id, input.revision, input.ownerId]) requireIdentity(value)
  const pages: KnowledgePage[] = []
  for (const id of new Set(input.pageIds)) {
    const matches = input.index.pages.filter(page => page.id === id)
    if (matches.length !== 1) throw new Error('Publication page must resolve exactly once')
    const page = matches[0]!
    // Owner metadata, paths, links and source records can refer to private resources.
    pages.push({ id: page.id, title: page.title, text: page.text, path: page.id,
      frontmatter: {}, sourceIds: [], tags: [], outLinks: [] })
  }
  const index: KnowledgeIndex = { root: '', generatedAt: '', sources: [], pages, graph: { nodes: [], edges: [] } }
  const publicPage = (page: KnowledgePage): PublishedKnowledgePage =>
    Object.freeze({ id: page.id, title: page.title, text: page.text })
  return Object.freeze({
    id: input.id, revision: input.revision, ownerId: input.ownerId, systemPrompt: input.systemPrompt,
    read: (id: string) => {
      const page = pages.find(candidate => candidate.id === id)
      return page ? publicPage(page) : null
    },
    search: (query: string) => searchKnowledge(index, query, { limit: 10 }).map(hit => publicPage(hit.page)),
  })
}

/** Authenticated server identity. Never construct this from model arguments or request JSON. */
export interface ConsultationConsumer {
  method: string
  consumerId: string
  keyId?: string
  ownerId?: string
  requestId: string
  threadId?: string
}

export interface ConsultationAgent {
  id: string
  ownerId: string
}

export interface ConsultationIdentity {
  readonly publicationId: string
  readonly publicationRevision: string
  readonly consumerId: string
  readonly paymentMethod: string
  readonly workspaceId: string
  readonly threadId: string
}

export interface ConsultationExecution {
  readonly identity: ConsultationIdentity
  readonly systemPrompt: string
  readonly prompt: string
  readonly priorMessages: ReadonlyArray<{ role: string; content: string }>
  readonly tools: McpToolDefinition[]
}

export interface PublicConsultationOptions {
  /** Resolve only deliberately published snapshots. Return null after revocation. */
  resolvePublication(agentId: string): Promise<KnowledgePublication | null>
  /** Payment authentication does not substitute for this admission decision. */
  allowConsumer(publication: KnowledgePublication, consumer: ConsultationConsumer): Promise<boolean>
  store: ChatTurnMessageStore
  turnStore: TurnEventStore
  /** Shared durable single-flight lock. Use createDurableTurnLock with thread scope. */
  turnLock: ChatTurnLock<void>
  /** Create or read the stored parent row. Return its actual persisted ownership. */
  ensureConversation(identity: ConsultationIdentity): Promise<{ workspaceId: string; threadId: string }>
  /** Run in an isolated executor with only these capabilities; do not reuse an owner's sandbox. */
  produce(input: ConsultationExecution): ChatTurnRouteProducer | Promise<ChatTurnRouteProducer>
}

interface GatewayConsultationContext {
  consumerId: string
  paymentMethod: string
  requestId: string
  threadId?: string
  keyInfo: { keyId: string; ownerId?: string } | null
  messages: Array<{ role: string; content: string }>
}

/** Compose gateway admission, scoped knowledge and the maintained persisted chat route. */
export function createPublicConsultation(options: PublicConsultationOptions) {
  if (typeof options.turnLock?.acquire !== 'function' || typeof options.turnLock.release !== 'function') {
    throw new Error('Public consultation requires a shared turn lock')
  }
  async function ownsConversation(identity: ConsultationIdentity) {
    const conversation = await options.ensureConversation(identity)
    return conversation?.workspaceId === identity.workspaceId && conversation.threadId === identity.threadId
  }
  async function resolve(agent: ConsultationAgent, consumer: ConsultationConsumer) {
    requireIdentity(consumer.consumerId)
    requireIdentity(consumer.method)
    requireIdentity(consumer.threadId)
    const publication = await options.resolvePublication(agent.id)
    if (!publication || publication.id !== agent.id || publication.ownerId !== agent.ownerId
      || await options.allowConsumer(publication, consumer) !== true) return null
    const workspaceId = await scopedId([publication.ownerId, publication.id, publication.revision, consumer.method, consumer.consumerId])
    const threadId = await scopedId([workspaceId, consumer.threadId!])
    const identity: ConsultationIdentity = Object.freeze({
      publicationId: publication.id, publicationRevision: publication.revision,
      consumerId: consumer.consumerId, paymentMethod: consumer.method, workspaceId, threadId,
    })
    return { publication, identity }
  }

  return {
    async authorizeConsumer(agent: ConsultationAgent, consumer: ConsultationConsumer) {
      const scope = await resolve(agent, consumer)
      return scope
        ? { allow: true as const }
        : { allow: false as const, reason: 'Consultation access denied', code: 'consultation_forbidden' }
    },
    async readKnowledge(agent: ConsultationAgent, consumer: ConsultationConsumer, pageId: string) {
      const scope = await resolve(agent, consumer)
      if (!scope) throw new Error('Consultation access denied')
      return scope.publication.read(pageId)
    },
    async readHistory(agent: ConsultationAgent, consumer: ConsultationConsumer) {
      const scope = await resolve(agent, consumer)
      if (!scope) throw new Error('Consultation access denied')
      if (!await ownsConversation(scope.identity)) throw new Error('Consultation conversation conflict')
      return (await options.store.listMessages(scope.identity.threadId))
        .map(({ role, content }) => ({ role, content }))
    },
    async getSandbox(agent: ConsultationAgent, context?: GatewayConsultationContext) {
      if (!context) throw new Error('Authenticated consultation identity is required')
      const consumer: ConsultationConsumer = {
        consumerId: context.consumerId, method: context.paymentMethod,
        requestId: context.requestId, threadId: context.threadId,
        keyId: context.keyInfo?.keyId, ownerId: context.keyInfo?.ownerId,
      }
      const scope = await resolve(agent, consumer)
      if (!scope) throw new Error('Consultation access denied')
      // Client-supplied history and owner system prompts never enter this producer.
      const prompt = context.messages.filter(message => message.role === 'user').at(-1)?.content
      if (!prompt) throw new Error('Consultation requires a user message')
      return {
        streamPrompt: (_message: string, streamOptions?: { signal?: AbortSignal }) => {
          const routes = createChatTurnRoutes({
            projectId: 'public-consultation', store: options.store, turnStore: options.turnStore, turnLock: options.turnLock,
            authorize: async ({ intent, body }) => {
              const current = await resolve(agent, consumer)
              if (intent !== 'turn' || !current
                || current.identity.workspaceId !== scope.identity.workspaceId
                || body?.workspaceId !== scope.identity.workspaceId || body.threadId !== scope.identity.threadId) {
                return { ok: false, response: Response.json({ error: 'Consultation access denied' }, { status: 403 }) }
              }
              if (!await ownsConversation(scope.identity)) {
                return { ok: false, response: Response.json({ error: 'Consultation conversation conflict' }, { status: 403 }) }
              }
              return { ok: true, tenantId: scope.identity.workspaceId,
                userId: scope.identity.consumerId, context: undefined }
            },
            produce: args => options.produce({
              identity: scope.identity, systemPrompt: scope.publication.systemPrompt, prompt,
              priorMessages: args.priorMessages.map(({ role, content }) => ({ role, content })),
              tools: publicationTools(scope.publication, async () => {
                const current = await resolve(agent, consumer)
                if (!current || current.identity.workspaceId !== scope.identity.workspaceId) {
                  throw new Error('Consultation access denied')
                }
              }),
            }),
          })
          return streamChatRouteAsSandboxEvents({
            routes, request: new Request('https://consultation.invalid/internal'),
            payload: { workspaceId: scope.identity.workspaceId, threadId: scope.identity.threadId,
              content: prompt, turnId: consumer.requestId }, signal: streamOptions?.signal,
          })
        },
      }
    },
  }
}

function publicationTools(publication: KnowledgePublication, authorize: () => Promise<void>): McpToolDefinition[] {
  return [
    { name: 'knowledge_search', description: 'Search published consultation knowledge.',
      inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } }, additionalProperties: false },
      run: async args => { await authorize(); return publication.search(singleArgument(args, 'query')) } },
    { name: 'knowledge_read', description: 'Read a published page by its exact citation id.',
      inputSchema: { type: 'object', required: ['pageId'], properties: { pageId: { type: 'string' } }, additionalProperties: false },
      run: async args => { await authorize(); return publication.read(singleArgument(args, 'pageId')) } },
  ]
}

function singleArgument(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (Object.keys(args).length !== 1 || typeof value !== 'string' || !value.trim() || value.length > 8192) {
    throw new Error('Invalid published knowledge arguments')
  }
  return value
}

function requireIdentity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new Error('Invalid consultation identity')
}

async function scopedId(parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)))
  return `consultation:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
}
