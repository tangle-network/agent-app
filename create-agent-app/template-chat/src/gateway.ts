/**
 * API-key access to the same persisted chat path the browser uses.
 *
 * The gateway translates OpenAI-compatible requests. The chat route still owns
 * the sandbox turn, transcript, replay buffer, and failure handling.
 */

import { OPERATOR_API_SCOPES, OPERATOR_SCOPE_DEPENDENCIES } from '@tangle-network/agent-app/operator'
import { buildOperatorApi, type OperatorAppOptions } from './operator'
import { config } from '../agent.config'
import { streamChatRouteAsSandboxEvents } from '@tangle-network/agent-app/chat-routes'
import {
  createAgentGateway,
  createApiKeyRequestClaim,
  createApiKeyRoutes,
  createApiKeyUsageSettlement,
  d1ToSqlAdapter,
  SqlApiKeyStore,
  SqlGatewayUsageStore,
  verifyApiKeyFromStore,
  type SqlAdapter,
} from '@tangle-network/agent-gateway'
import { Hono } from 'hono'
import { buildChatApp, type ChatApp } from './chat'
import type { AppEnv } from './env'
import { appSlug } from './sandbox'

export interface GatewayAppOptions extends Pick<OperatorAppOptions, 'files' | 'assets'> {
  /** Keep the persisted chat turn alive after an API client disconnects. */
  waitUntil?: (promise: Promise<unknown>) => void
  /** Test override. Production uses the D1 adapter from agent-gateway. */
  sql?: SqlAdapter
  /** Test override. Production builds one private, trusted chat assembly. */
  createTrustedChatApp?: (ownerId: string) => ChatApp
}

async function sessionUserId(app: ChatApp, request: Request): Promise<string | null> {
  try {
    return (await app.auth.getSession(request))?.user.id ?? null
  } catch {
    return null
  }
}

async function ensureOwnedThread(
  app: ChatApp,
  threadId: string,
  ownerId: string,
  firstMessage: string,
): Promise<void> {
  const existing = await app.store.getThread(threadId)
  if (existing) {
    if (existing.workspaceId !== ownerId) throw new Error('Gateway thread is unavailable')
    return
  }

  try {
    await app.store.createThread({ id: threadId, workspaceId: ownerId, firstMessage })
  } catch (error) {
    // Two requests can create the same caller-supplied conversation at once.
    // The primary key chooses one winner; the loser adopts that owned row.
    const raced = await app.store.getThread(threadId)
    if (!raced || raced.workspaceId !== ownerId) throw error
  }
}

/** Build the external API surface. The Worker mounts only these Hono routes. */
export function buildGatewayApp(
  env: AppEnv,
  chatApp: ChatApp,
  options: GatewayAppOptions = {},
) {
  const sql = options.sql ?? d1ToSqlAdapter(env.DB)
  const apiKeys = new SqlApiKeyStore(sql)
  const usage = new SqlGatewayUsageStore(sql)
  const trustedChatApp = options.createTrustedChatApp
    ?? ((ownerId: string) => buildChatApp(env, { trustedUserId: ownerId }))

  const verifyKey = (authorization: string) =>
    verifyApiKeyFromStore(authorization, apiKeys)

  const gateway = createAgentGateway({
    resolveAgent: async (slug) => slug === appSlug && config.gateway.enabled
      ? {
          id: appSlug,
          ownerId: appSlug,
          slug: appSlug,
          systemPrompt: config.systemPrompt,
          pricePerTokenUsd: config.gateway.pricePerTokenUsd,
          platformFeePercent: config.gateway.platformFeePercent,
          sandboxEndpoint: null,
          remoteSandboxId: null,
          remoteBearerToken: null,
          enabled: true,
          harness: config.harness,
          harnessModel: config.model.default,
          description: config.gateway.description,
        }
      : null,
    verifyApiKey: verifyKey,
    claimApiKeyRequest: createApiKeyRequestClaim(apiKeys),
    apiKeyReservationLifecycle: apiKeys.reservations,
    apiKeyPrefix: 'ak_',
    conversationMode: 'thread',
    // A2A task control remains off until the shared gateway owns durable
    // cross-isolate cancel and replay. OpenAI-compatible calls are independent.
    a2a: false,
    authorizeConsumer: async (_agent, consumer) => {
      if (consumer.method !== 'apikey' || !consumer.ownerId || !consumer.threadId) {
        return { allow: false, reason: 'API key owner is unavailable', code: 'owner_unavailable' }
      }
      const thread = await chatApp.store.getThread(consumer.threadId)
      if (thread && thread.workspaceId !== consumer.ownerId) {
        return { allow: false, reason: 'Thread is unavailable', code: 'thread_unavailable' }
      }
      return { allow: true }
    },
    // A sandbox session can retain private tool output that is absent from the
    // visible transcript. The model input limit is the only complete bound.
    unauthenticatedInputTokenBound: config.gateway.maxProviderInputTokens,
    getSandbox: async (_agent, context) => {
      const ownerId = context?.keyInfo?.ownerId
      const threadId = context?.threadId
      if (!ownerId || !threadId) throw new Error('Gateway request has no verified owner or thread')

      const firstMessage = context.messages
        .filter((message) => message.role === 'user')
        .at(-1)?.content ?? ''
      const app = trustedChatApp(ownerId)
      await ensureOwnedThread(app, threadId, ownerId, firstMessage)

      return {
        streamPrompt: (message, streamOptions) => streamChatRouteAsSandboxEvents({
          routes: app.routes,
          request: new Request(`${env.BETTER_AUTH_URL}/api/chat`, {
            headers: { 'X-Gateway-Request-Id': context.requestId },
          }),
          payload: {
            workspaceId: ownerId,
            threadId,
            content: message,
            turnId: context.requestId,
          },
          waitUntil: options.waitUntil,
          signal: streamOptions?.signal,
          executionLimits: streamOptions?.executionBudget,
        }),
      }
    },
    recordUsage: usage.recordUsage,
    ...(options.waitUntil ? { continueOnDisconnect: options.waitUntil } : {}),
    settlePayment: createApiKeyUsageSettlement(apiKeys),
    defaultOutputTokens: config.gateway.defaultOutputTokens,
    maxOutputTokens: config.gateway.maxOutputTokens,
  })

  const app = new Hono()
  app.use('/api/keys', async (c, next) => {
    if (c.req.method === 'POST' && env.OPERATOR_RUN_ENABLED !== 'true') {
      const body = await c.req.raw.clone().json().catch(() => null) as { scopes?: unknown } | null
      if (Array.isArray(body?.scopes) && body.scopes.includes('operator:run')) return c.json({ error: 'The deployment payer has not enabled operator execution', code: 'operator.execution_disabled' }, 403)
    }
    await next()
  })
  app.get('/api/keys/access', async c => {
    if (!await sessionUserId(chatApp, c.req.raw)) return c.json({ error: 'Unauthorized' }, 401)
    return c.json({ operatorRunEnabled: env.OPERATOR_RUN_ENABLED === 'true' })
  })
  app.route('/api/keys', createApiKeyRoutes({
    store: apiKeys,
    prefix: 'ak_',
    validScopes: ['chat', ...OPERATOR_API_SCOPES.filter(scope => scope !== 'operator:run' || env.OPERATOR_RUN_ENABLED === 'true')],
    scopeDependencies: env.OPERATOR_RUN_ENABLED === 'true' ? OPERATOR_SCOPE_DEPENDENCIES : {},
    requireExpiryForScopes: OPERATOR_API_SCOPES.filter(scope => scope !== 'operator:run' || env.OPERATOR_RUN_ENABLED === 'true'),
    getAuthUserId: (request) => sessionUserId(chatApp, request),
  }))
  app.route('/v1/agents', gateway)
  const operator = buildOperatorApi(env, chatApp, options)
  app.all('/api/operator/v1', c => operator.handle(c.req.raw))
  app.all('/api/operator/v1/*', c => operator.handle(c.req.raw))
  return app
}
