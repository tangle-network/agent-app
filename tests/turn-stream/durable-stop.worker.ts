/** Full product-route proof; transport and DO implementations live once in the shared fixture entrypoint. */
import { createDurableTurnLock, createDurableObjectTurnEventStore } from '../../src/turn-stream/adapters'
import { requestDurableTurnCancellation, type TurnCancellationIdentity } from '../../src/turn-stream/cancellation'
import { createChatTurnRoutes } from '../../src/chat-routes/turn-routes'
import type { ChatTurnMessageStore } from '../../src/chat-routes/turn-route-contracts'
import { handleDurableStopTransport, type StopFixtureEnv as Env, type StopFixtureContext as Context } from './durable-stop.transport'
export { FixtureTurnStream, ShortTurnStream, ControlOutageTurnStream, DeferredTurnStream, ShortDeferredTurnStream, BarrierTurnStream, PublishedTurnStream } from './durable-stop.transport'

function messages(env: Env): ChatTurnMessageStore {
  return {
    async listMessages(threadId) {
      const { results } = await env.CHAT.prepare('SELECT id, role, content, parts FROM messages WHERE thread_id = ? ORDER BY rowid')
        .bind(threadId).all<{ id: string; role: 'user' | 'assistant' | 'system' | 'tool'; content: string; parts: string | null }>()
      return results.map(row => ({ ...row, parts: row.parts ? JSON.parse(row.parts) : null }))
    },
    async appendMessage(input) {
      const id = input.id ?? crypto.randomUUID()
      await env.CHAT.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)')
        .bind(id, input.threadId, input.role, input.content, input.parts ? JSON.stringify(input.parts) : null).run()
      return { id }
    },
  }
}

function routes(env: Env) {
  let signal: AbortSignal | undefined
  const baseLock = createDurableTurnLock({ namespace: env.TURNS, auth: { secret: env.TURN_STREAM_AUTH_SECRET },
    scopeOf: () => 'thread', cancellationOf: () => true })
  return createChatTurnRoutes({ projectId: 'durable-stop-fixture', store: messages(env),
    turnStore: createDurableObjectTurnEventStore(env.TURNS, { secret: env.TURN_STREAM_AUTH_SECRET }),
    turnTrace: false, log: (message, meta) => console.info('[durable-stop-fixture]', message, JSON.stringify(meta ?? {})),
    authorize: async ({ request, intent, body, threadId: runningThreadId }) => {
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? ''
      const { results } = await env.CHAT.prepare('SELECT user_id, workspace_id, role FROM members WHERE token = ?')
        .bind(token).all<{ user_id: string; workspace_id: string; role: string }>()
      const member = results[0]
      if (!member) return { ok: false as const, response: new Response('Unauthorized', { status: 401 }) }
      const threadId = intent === 'running' ? runningThreadId
        : intent === 'turn' || intent === 'cancel' ? body?.threadId : undefined
      if (!threadId) return { ok: false as const, response: new Response('Forbidden', { status: 403 }) }
      const thread = await env.CHAT.prepare('SELECT workspace_id FROM threads WHERE id = ?')
        .bind(threadId).all<{ workspace_id: string }>()
      if (member.role !== 'editor' || thread.results[0]?.workspace_id !== member.workspace_id) {
        return { ok: false as const, response: new Response('Forbidden', { status: 403 }) }
      }
      return { ok: true as const, tenantId: member.workspace_id, userId: member.user_id,
        context: { signal: undefined as AbortSignal | undefined } }
    },
    cancel: { async target(args) {
      await env.CHAT.prepare('INSERT INTO target_reads VALUES (?, ?)').bind(args.body.threadId, args.messageId ? 'observation' : 'request').run()
      const { results } = await env.CHAT.prepare('SELECT metadata FROM control_targets WHERE thread_id = ? AND client_turn_id = ?')
        .bind(args.body.threadId, args.body.turnId).all<{ metadata: string }>()
      if (!results[0]) return new Response('Target not found', { status: 404 })
      const captured = JSON.parse(results[0].metadata) as TurnCancellationIdentity & Record<string, unknown> & { dispatchToken: string; responseStatus: string }
      if (captured.workspaceId !== args.tenantId) return new Response('Forbidden', { status: 403 })
      return { capturedMetadata: captured, status: captured.responseStatus, requiresDispatchToken: true, dispatchToken: captured.dispatchToken,
        control: { async request(snapshot: Record<string, unknown>) {
          const current = await env.CHAT.prepare('SELECT metadata FROM control_targets WHERE thread_id = ?').bind(args.body.threadId).all<{ metadata: string }>()
          if (current.results[0]?.metadata !== JSON.stringify(snapshot)) return { requested: false }
          return requestDurableTurnCancellation(env.TURNS, captured, { secret: env.TURN_STREAM_AUTH_SECRET })
        } },
        async markStopped(snapshot: Record<string, unknown>, stoppedAt: string) {
          await env.CHAT.prepare('INSERT INTO forbidden_effects VALUES (?)').bind('premature-stopped').run()
          const updated = await env.CHAT.prepare('UPDATE control_targets SET metadata = ? WHERE thread_id = ? AND metadata = ? RETURNING thread_id')
            .bind(JSON.stringify({ ...snapshot, responseStatus: 'stopped', stoppedAt }), args.body.threadId, JSON.stringify(snapshot)).all()
          return updated.results.length > 0
        },
      }
    } },
    turnLock: { ...baseLock, async acquire(args) {
      const acquired = await baseLock.acquire(args)
      if (!acquired.acquired) return acquired
      try {
        const captured = { ...(acquired.handle as TurnCancellationIdentity), turnStreamId: args.turnStreamId,
          dispatchToken: `dispatch-${args.executionId}`, responseStatus: 'running' }
        await env.CHAT.prepare('INSERT OR REPLACE INTO control_targets VALUES (?, ?, ?)')
          .bind(args.identity.sessionId, args.body.turnId ?? '', JSON.stringify(captured)).run()
        await fetch(`${env.MODEL_URL}/admitted`, { method: 'POST' })
        return acquired
      } catch (error) {
        acquired.cancellation?.close()
        await baseLock.release(acquired.handle)
        throw error
      }
    }, async release(handle) {
      await baseLock.release(handle)
      await fetch(`${env.MODEL_URL}/released`, { method: 'POST', body: JSON.stringify({ aborted: signal?.aborted }) })
    } },
    produce: { router(args) {
      args.context.signal = args.admissionSignal
      signal = args.admissionSignal
      return { apiKey: 'fixture-no-spend', model: 'fixture/model', baseUrl: `${env.MODEL_URL}/v1`,
        systemPrompt: 'Answer the member.', repeat: false }
    } },
    lifecycle: {
      async onTurnError(info) {
        const reason = info.context.signal?.reason as { code?: string } | undefined
        await env.CHAT.prepare('INSERT INTO effects VALUES (?, ?)').bind(info.turnStreamId, reason?.code ?? 'unknown').run()
        // The actual consumer has a terminal effect to finish. Hold it through a real HTTP boundary.
        await fetch(`${env.MODEL_URL}/settlement`, { method: 'POST' })
        await env.CHAT.prepare("UPDATE control_targets SET metadata = json_set(metadata, '$.responseStatus', 'error') WHERE thread_id = ? AND json_extract(metadata, '$.executionId') = ?")
          .bind(info.identity.sessionId, info.executionId).run()
      },
      async onTurnComplete(info) {
        await env.CHAT.prepare('INSERT INTO effects VALUES (?, ?)').bind(info.turnStreamId, 'complete').run()
        await fetch(`${env.MODEL_URL}/settlement`, { method: 'POST' })
        await env.CHAT.prepare("UPDATE control_targets SET metadata = json_set(metadata, '$.responseStatus', 'answered') WHERE thread_id = ? AND json_extract(metadata, '$.executionId') = ?")
          .bind(info.identity.sessionId, info.executionId).run()
      },
    },
  })
}

export default {
  async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    const url = new URL(request.url)
    // Product endpoints retain the complete shared authorization, route and SQLite proof.
    if (url.pathname === '/turn') return routes(env).turn(request, { waitUntil: promise => ctx.waitUntil(promise) })
    if (url.pathname === '/cancel') return routes(env).cancel(request)
    return handleDurableStopTransport(request, env)
  },
}
