/** Scoped external-agent access to this app's existing personal workspace.
 * Uses the shared operator contract, key store and persisted chat path.
 */
import { createChatOperatorAdapter, createOperatorApi, OperatorError, type ChatOperatorAdapterOptions } from '@tangle-network/agent-app/operator'
import { d1ToSqlAdapter, SqlApiKeyStore, verifyApiKeyFromStore, type SqlAdapter } from '@tangle-network/agent-gateway'
import { config } from '../agent.config'
import { buildChatApp, type ChatApp } from './chat'
import type { AppEnv } from './env'
import { appSlug } from './sandbox'

export interface OperatorAppOptions {
  sql?: SqlAdapter
  createTrustedChatApp?: (ownerId: string) => ChatApp
  /** Product-owned safe storage adapters. Never substitute unconfined sandbox reads. */
  files?: ChatOperatorAdapterOptions<Identity>['files']
  assets?: ChatOperatorAdapterOptions<Identity>['assets']
  waitUntil?: (promise: Promise<unknown>) => void
}

export interface Identity { userId: string; spendingLimitCents: number | null }

export function buildOperatorApi(env: AppEnv, chat: ChatApp, options: OperatorAppOptions = {}) {
  const sql = options.sql ?? d1ToSqlAdapter(env.DB)
  const keys = new SqlApiKeyStore(sql)
  const trusted = options.createTrustedChatApp ?? ((ownerId: string) => buildChatApp(env, { trustedUserId: ownerId }))
  const origin = new URL(env.BETTER_AUTH_URL).origin
  const workspace = (userId: string) => ({ id: userId, name: config.name, role: 'owner' as const })
  const requestFor = (path: string) => new Request(origin + path)
  const adapter = createChatOperatorAdapter<Identity>({
    origin,
    admissions: {
      get: async (ctx, workspaceId, turnId) => {
        if (workspaceId !== ctx.identity.userId) return null
        const rows = await sql.query<{ thread_id: string; refusal_json: string | null }>('SELECT thread_id, refusal_json FROM operator_turn_admissions WHERE owner_id = ? AND turn_id = ? LIMIT 1', [ctx.identity.userId, turnId])
        const row = rows[0]
        return row ? { threadId: row.thread_id, ...(row.refusal_json ? { refusal: JSON.parse(row.refusal_json) as { code?: string; message: string } } : {}) } : null
      },
      claim: async (ctx, input) => {
        if (input.workspaceId !== ctx.identity.userId) throw new OperatorError('operator.workspace_not_found', 404)
        const result = await sql.exec('INSERT INTO operator_turn_admissions (owner_id, turn_id, thread_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id, turn_id) DO NOTHING', [ctx.identity.userId, input.turnId, input.threadId, Date.now()])
        return result.rowsAffected === 1
      },
      recordRefusal: async (ctx, input, refusal) => {
        await sql.exec('UPDATE operator_turn_admissions SET refusal_json = ? WHERE owner_id = ? AND turn_id = ? AND thread_id = ?', [JSON.stringify(refusal), ctx.identity.userId, input.turnId, input.threadId])
      },
    },
    ...(options.files ? { files: options.files } : {}),
    ...(options.assets ? { assets: options.assets } : {}),
    workspacePath: () => '/',
    threadPath: (_workspace, threadId) => `/?threadId=${encodeURIComponent(threadId)}`,
    workspaces: {
      list: async ctx => [workspace(ctx.identity.userId)],
      authorize: async (ctx, id, access) => {
        if (id !== ctx.identity.userId) return null
        if (access === 'run' && env.OPERATOR_RUN_ENABLED !== 'true') throw new OperatorError('operator.execution_disabled', 403, 'The deployment payer has not enabled operator execution')
        if (access === 'run' && ctx.identity.spendingLimitCents !== null) throw new OperatorError('operator.capped_execution_unsupported', 402, 'This lane cannot enforce a finite key spending cap')
        return workspace(id)
      },
    },
    threads: {
      get: async (id, ctx) => {
        const thread = await chat.store.getThread(id)
        return thread?.workspaceId === ctx.identity.userId ? thread : null
      },
      create: async (ctx, input) => {
        if (input.workspaceId !== ctx.identity.userId) throw new OperatorError('operator.workspace_not_found', 404)
        return chat.store.createThread(input)
      },
      listMessages: async (id, ctx) => {
        const thread = await chat.store.getThread(id)
        if (!thread || thread.workspaceId !== ctx.identity.userId) throw new OperatorError('operator.thread_not_found', 404)
        const rows = await chat.store.listMessages(id, { limit: 1000 })
        if (rows.length === 1000) throw new OperatorError('operator.history_limit', 503, 'This conversation needs a paginated product history adapter')
        return rows
      },
      list: async (_ctx, workspaceId, query) => {
        const offset = query.cursor === undefined ? 0 : Number(query.cursor)
        if (!Number.isSafeInteger(offset) || offset < 0) throw new OperatorError('operator.invalid_cursor', 400)
        const page = await chat.store.listThreads({ workspaceId, limit: query.limit, offset })
        const next = offset + page.threads.length
        return { threads: page.threads, nextCursor: next < page.total ? String(next) : null }
      },
    },
    turnStatus: async (_ctx, _workspaceId, _threadId, user) => {
      const rows = await sql.query<{ turn_stream_id: string | null; backend_terminal: number }>('SELECT turn_stream_id, backend_terminal FROM message WHERE id = ? LIMIT 1', [user.id])
      const id = rows[0]?.turn_stream_id
      if (!id) return null
      const status = await chat.turnStore.getStatus(id)
      return rows[0]?.backend_terminal ? status : status === 'running' ? 'running' : null
    },
    runningTurns: async (ctx, _workspaceId, threadId) => {
      const response = await trusted(ctx.identity.userId).routes.running(requestFor(`/api/chat/running?threadId=${encodeURIComponent(threadId)}`))
      if (!response.ok) return null
      const body = await response.json() as { running?: string[] }
      return Array.isArray(body.running) ? body.running : null
    },
    approvals: async (ctx, _workspaceId, threadId) => {
      const app = trusted(ctx.identity.userId)
      if (!app.routes.interactions) throw new OperatorError('operator.unsupported', 501)
      const page = threadId ? { threads: [{ id: threadId }], total: 1 } : await chat.store.listThreads({ workspaceId: ctx.identity.userId, limit: 100 })
      if (page.total > page.threads.length) throw new OperatorError('operator.approvals_limit', 503, 'A product-wide approval index is required for this many conversations; the result would be incomplete')
      const threads = page.threads
      const approvals = []
      for (const thread of threads) {
        const response = await app.routes.interactions.list(requestFor(`/api/chat/interactions?threadId=${encodeURIComponent(thread.id)}`))
        if (!response.ok) throw new OperatorError('operator.approvals_unavailable', 503, 'Cannot establish pending decisions', true)
        const body = await response.json() as { unavailable?: string; interactions?: Array<{ id: string; kind: string; title?: string }> }
        if (body.unavailable) throw new OperatorError('operator.approvals_unavailable', 503, 'Cannot establish pending decisions', true)
        for (const interaction of body.interactions ?? []) {
          approvals.push({ id: interaction.id, kind: interaction.kind === 'permission' ? 'permission' as const : interaction.kind === 'plan' ? 'plan' as const : 'question' as const,
            title: interaction.title ?? 'Your agent needs a decision', threadId: thread.id, decidedBy: 'owner' as const,
            url: `${origin}/?threadId=${encodeURIComponent(thread.id)}` })
        }
      }
      return approvals
    },
    runTurn: async (ctx, input) => {
      // The browser path bills the deployment's provider credentials. A capped
      // key must never enter it and silently bypass the gateway's enforcement.
      if (env.OPERATOR_RUN_ENABLED !== 'true') throw new OperatorError('operator.execution_disabled', 403, 'The deployment payer has not enabled operator execution')
      if (ctx.identity.spendingLimitCents !== null) throw new OperatorError('operator.capped_execution_unsupported', 402, 'Use the paid gateway with a backend that enforces this key spending cap')
      return trusted(ctx.identity.userId).routes.turn(new Request(origin + '/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: input.threadId, turnId: input.turnId, content: input.content, ...(input.model ? { model: input.model } : {}) }),
      }), { waitUntil: options.waitUntil ?? (() => undefined) })
    },
  })
  return createOperatorApi({
    app: { id: appSlug, name: config.name },
    keys: {
      verify: async authorization => {
        const found = await verifyApiKeyFromStore(authorization, keys, 'ak_')
        return found ? { ...found, expiresAt: found.key.expiresAt?.getTime() ?? 0 } : null
      },
      resolveIdentity: async key => {
        const rows = await sql.query<{ id: string }>('SELECT id FROM users WHERE id = ? LIMIT 1', [key.ownerId])
        return rows.length ? { userId: key.ownerId, spendingLimitCents: key.spendingLimitCents } : null
      },
      claimRequest: async (key, requestId) => {
        const result = await keys.claimRequest(key.keyId, requestId, new Date(), 0)
        // Reads consume request quota, not money. Execution checks its authority separately.
        if (result.allowed) await keys.reservations.release(key.keyId, requestId)
        return { allowed: result.allowed, ...(result.allowed ? {} : { retryAfterSeconds: Math.max(1, Math.ceil(((result.reason === 'daily' ? result.dailyResetAt : result.minuteResetAt) - Date.now()) / 1000)) }) }
      },
    },
    adapter,
  })
}
