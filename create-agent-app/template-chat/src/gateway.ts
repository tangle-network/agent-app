/**
 * API-key access to the same persisted chat path the browser uses.
 *
 * The gateway translates OpenAI-compatible requests. The chat route still owns
 * the sandbox turn, transcript, replay buffer, and failure handling.
 */

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

export interface GatewayAppOptions {
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
    apiKeyPrefix: 'ak_',
    conversationMode: 'thread',
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
        }),
      }
    },
    recordUsage: usage.recordUsage,
    settlePayment: createApiKeyUsageSettlement(apiKeys),
    defaultOutputTokens: config.gateway.defaultOutputTokens,
    maxOutputTokens: config.gateway.maxOutputTokens,
  })

  const app = new Hono()
  app.route('/api/keys', createApiKeyRoutes({
    store: apiKeys,
    prefix: 'ak_',
    getAuthUserId: (request) => sessionUserId(chatApp, request),
  }))
  app.route('/v1/agents', gateway)
  return app
}
