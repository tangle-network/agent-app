/** Full product-route proof; transport and DO implementations live once in the shared fixture entrypoint. */
import { createDurableTurnLock, createDurableObjectTurnEventStore } from '../../src/turn-stream/adapters'
import { requestDurableTurnCancellation, requestHostedTurnCancellation, type TurnCancellationIdentity } from '../../src/turn-stream/cancellation'
import { TurnStreamDO, type TurnStreamDOState, type TurnStreamSocket } from '../../src/turn-stream/do'
import { TURN_STREAM_TOKEN_HEADER, mintTurnStreamToken, turnHostChannelKey } from '../../src/turn-stream/core'
import { isTurnHostControlEvent, type TurnHostControlTarget } from '../../src/chat-routes/turn-progress'
import { createChatTurnRoutes } from '../../src/chat-routes/turn-routes'
import type { ChatTurnMessageStore } from '../../src/chat-routes/turn-route-contracts'
import { serverFailureData } from '../../src/chat-routes/turn-event-stream'
import { handleDurableStopTransport, type StopFixtureEnv as Env, type StopFixtureContext as Context } from './durable-stop.transport'
export { FixtureTurnStream, ShortTurnStream, ControlOutageTurnStream, DeferredTurnStream, ShortDeferredTurnStream, BarrierTurnStream, PublishedTurnStream } from './durable-stop.transport'

function messages(env: Env): ChatTurnMessageStore {
  return {
    async listMessages(threadId) {
      if (threadId === 'host-history-stop') await fetch(`${env.MODEL_URL}/host-history?thread=${encodeURIComponent(threadId)}`)
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

async function editor(request: Request, threadId: string | undefined, env: Env) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '')
    ?? request.headers.get('Cookie')?.match(/(?:^|;\s*)fixture_session=([^;]+)/)?.[1] ?? ''
  const { results } = await env.CHAT.prepare('SELECT user_id, workspace_id, role FROM members WHERE token = ?')
    .bind(token).all<{ user_id: string; workspace_id: string; role: string }>()
  const member = results[0]
  if (!member) return { ok: false as const, response: new Response('Unauthorized', { status: 401 }) }
  const thread = await env.CHAT.prepare('SELECT workspace_id FROM threads WHERE id = ?')
    .bind(threadId ?? '').all<{ workspace_id: string }>()
  if (member.role !== 'editor' || thread.results[0]?.workspace_id !== member.workspace_id) {
    return { ok: false as const, response: new Response('Forbidden', { status: 403 }) }
  }
  return { ok: true as const, tenantId: member.workspace_id, userId: member.user_id }
}

function routes(env: Env, hosted = false, hostNamespace = env.HOST_TURNS) {
  let signal: AbortSignal | undefined
  const baseLock = createDurableTurnLock({ namespace: env.TURNS, auth: { secret: env.TURN_STREAM_AUTH_SECRET },
    scopeOf: () => hosted ? 'workspace' : 'thread', cancellationOf: () => true })
  return createChatTurnRoutes({ projectId: 'durable-stop-fixture', store: messages(env),
    turnStore: createDurableObjectTurnEventStore(env.TURNS, { secret: env.TURN_STREAM_AUTH_SECRET }),
    turnTrace: false, log: (message, meta) => console.info('[durable-stop-fixture]', message, JSON.stringify(meta ?? {})),
    turnHost: hosted ? { namespace: hostNamespace, auth: { secret: env.TURN_STREAM_AUTH_SECRET } } : undefined,
    authorizeHostControl: hosted ? ({ request, body }) => editor(request, body.threadId, env) : undefined,
    authorize: async ({ request, intent, body, threadId: runningThreadId, turnId: replayId }) => {
      let threadId = intent === 'running' ? runningThreadId
        : intent === 'turn' || intent === 'cancel' ? body?.threadId : undefined
      if (hosted && intent === 'replay') {
        const replay = await env.CHAT.prepare("SELECT thread_id FROM control_targets WHERE json_extract(metadata, '$.turnStreamId') = ?")
          .bind(replayId).all<{ thread_id: string }>()
        threadId = replay.results[0]?.thread_id
      }
      const identity = await editor(request, threadId, env)
      if (!identity.ok) return identity
      if (intent === 'replay' || intent === 'running') return { ...identity, intent }
      if (hosted && intent === 'turn') {
        const paid = await fetch(`${env.MODEL_URL}/host-admission?client=${encodeURIComponent(body?.turnId ?? '')}`)
        if (!paid.ok) return { ok: false as const, response: new Response('Payment required', { status: paid.status }) }
      }
      return { ...identity,
        context: { signal: undefined as AbortSignal | undefined, threadId } }
    },
    prepareTurn: hosted ? async ({ body }) => {
      if (body.threadId === 'host-prepare-stop' || body.threadId === 'host-prepare-failure' || body.threadId === 'host-prepare-return') {
        const response = await fetch(`${env.MODEL_URL}/host-prepare?thread=${encodeURIComponent(body.threadId)}`)
        if (!response.ok) {
          if (body.threadId === 'host-prepare-return') return { ok: false as const, response }
          throw response
        }
      }
      return { ok: true as const }
    } : undefined,
    afterAuthorize: hosted ? ({ body }) => ({
      resource: env.CHAT.prepare('INSERT INTO host_steps VALUES (?, ?)').bind(body.threadId, 'early').run(),
      async dispose() {
        await fetch(`${env.MODEL_URL}/host-disposal?thread=${encodeURIComponent(body.threadId)}`)
        await env.CHAT.prepare('INSERT INTO host_steps VALUES (?, ?)').bind(body.threadId, 'disposed').run()
      },
    }) : undefined,
    intentLine: hosted ? { async generate({ threadId, signal }) {
      await fetch(`${env.MODEL_URL}/host-intent?thread=${encodeURIComponent(threadId)}`, { signal })
      return 'Reading the request.'
    } } : undefined,
    agents: hosted ? { async resolve({ identity }) {
      await fetch(`${env.MODEL_URL}/host-address?thread=${encodeURIComponent(identity.sessionId)}`)
      return []
    } } : undefined,
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
      if (hosted) await env.CHAT.prepare('INSERT INTO host_steps VALUES (?, ?)').bind(args.body.threadId, 'acquire').run()
      const acquired = await baseLock.acquire(args)
      if (!acquired.acquired) {
        if (args.body.threadId === 'host-lock-refusal') {
          await env.CHAT.prepare('INSERT INTO host_refusals VALUES (?, ?)')
            .bind(args.body.threadId, JSON.stringify({ status: acquired.response.status, body: await acquired.response.clone().text() })).run()
          await fetch(`${env.MODEL_URL}/host-lock-refusal?thread=${encodeURIComponent(args.body.threadId)}`)
        }
        return acquired
      }
      try {
        const captured = { ...(acquired.handle as TurnCancellationIdentity), turnStreamId: args.turnStreamId,
          dispatchToken: `dispatch-${args.executionId}`, responseStatus: 'running' }
        await env.CHAT.prepare('INSERT OR REPLACE INTO control_targets VALUES (?, ?, ?)')
          .bind(args.identity.sessionId, args.body.turnId ?? '', JSON.stringify(captured)).run()
        await fetch(`${env.MODEL_URL}/admitted`, { method: 'POST' })
        if (args.body.threadId.startsWith('host-acquire-stop')) {
          await fetch(`${env.MODEL_URL}/host-acquire?thread=${encodeURIComponent(args.body.threadId)}`)
        }
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
    onEvent: hosted ? async (event, context) => {
      if (context.threadId === 'host-provider-failure' && event.type === 'error') {
        await env.CHAT.prepare('INSERT OR IGNORE INTO host_failure_checkpoints VALUES (?, ?)')
          .bind(context.threadId, JSON.stringify(serverFailureData(event.data))).run()
        await fetch(`${env.MODEL_URL}/host-failure-observed`)
      }
    } : undefined,
    lifecycle: {
      async onTurnError(info) {
        // Hosted tests must observe the actual lifecycle error, not bypass the
        // stream helper through the producer's context.signal shortcut.
        const reason = (hosted ? info.error : info.context.signal?.reason) as { code?: string } | undefined
        if (hosted) await env.CHAT.prepare('INSERT INTO host_terminal_errors VALUES (?, ?, ?)')
          .bind(info.turnStreamId, reason?.code ?? 'unknown', JSON.stringify(info.error)).run()
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

export class HostedTurnStream extends TurnStreamDO {
  constructor(state: TurnStreamDOState, env: Env) {
    super(state, env, { turnRoutes: ownerEnv => ({ async turn(request, ctx) {
      const body = await request.clone().json() as { threadId: string; turnId: string }
      if (body.threadId === 'host-control-loss' || body.threadId === 'host-active-control-loss') ctx.hostControl!.signal.addEventListener('abort', () => {
        ctx.waitUntil!(fetch(`${(ownerEnv as Env).MODEL_URL}/host-control-revoked?client=${encodeURIComponent(body.turnId)}`))
      }, { once: true })
      return routes(ownerEnv as Env, true).turn(request, ctx)
    } }) })
  }
  async webSocketMessage(socket: TurnStreamSocket, message: string | ArrayBuffer) {
    await super.webSocketMessage(socket, message)
    const target = (socket.deserializeAttachment() as { host?: TurnHostControlTarget })?.host
    if (target?.threadId === 'host-control-loss' || target?.threadId === 'host-active-control-loss') {
      await fetch(`${(this.env as Env).MODEL_URL}/host-control-loss?client=${encodeURIComponent(target.clientTurnId ?? '')}`)
      socket.close(1011, 'sk-fixture-private-control-close')
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    const url = new URL(request.url)
    // Product endpoints retain the complete shared authorization, route and SQLite proof.
    if (url.pathname === '/turn') return routes(env).turn(request, { waitUntil: promise => ctx.waitUntil(promise) })
    if (url.pathname === '/cancel') return routes(env).cancel(request)
    if (url.pathname === '/host-turn') return routes(env, true).turn(request, ctx)
    if (url.pathname === '/host-loss') {
      // Fault only the outer transport after the real host publishes H and its
      // actual authenticated control operation accepts Stop. No fake producer.
      const namespace: Env['HOST_TURNS'] = {
        newUniqueId: () => env.HOST_TURNS.newUniqueId(),
        idFromName: name => env.HOST_TURNS.idFromName(name),
        idFromString: id => env.HOST_TURNS.idFromString(id),
        get: (id, options) => ({ async fetch(input, init) {
          const response = await env.HOST_TURNS.get(id, options).fetch(input, init)
          const reader = response.body!.getReader()
          let prefix = ''
          const decoder = new TextDecoder()
          while (!prefix.includes('\n')) {
            const { done, value } = await reader.read()
            if (done) throw new Error('The real host did not publish control')
            prefix += decoder.decode(value, { stream: true })
          }
          const event: unknown = JSON.parse(prefix.slice(0, prefix.indexOf('\n')))
          if (!isTurnHostControlEvent(event)) throw new Error('The real host did not publish control')
          const access = await editor(request, event.data.threadId, env)
          if (!access.ok || access.tenantId !== event.data.workspaceId) throw new Error('Stop requires editor thread access')
          const stop = await requestHostedTurnCancellation(env.HOST_TURNS, event.data, { secret: env.TURN_STREAM_AUTH_SECRET })
          await env.CHAT.prepare('INSERT INTO host_faults VALUES (?)').bind(JSON.stringify({ target: event.data, stop })).run()
          void reader.cancel().catch(() => {})
          throw new TypeError('Injected outer transport loss after accepted host Stop')
        } }),
      }
      return routes(env, true, namespace).turn(request, ctx)
    }
    if (url.pathname === '/host-running') return routes(env, true).running(request)
    if (url.pathname === '/host-replay') return routes(env, true).replay(request, { turnId: url.searchParams.get('turnId') ?? '' })
    if (url.pathname === '/host-cancel' || url.pathname === '/host-repeat' || url.pathname === '/host-unknown') {
      const target = await request.json() as TurnHostControlTarget
      const identity = await editor(request, target.threadId, env)
      if (!identity.ok) return identity.response
      if (target.workspaceId !== identity.tenantId) return new Response('Forbidden', { status: 403 })
      if (url.pathname === '/host-unknown') target.hostId = String(env.HOST_TURNS.newUniqueId())
      if (url.pathname !== '/host-repeat') return Response.json(await requestHostedTurnCancellation(env.HOST_TURNS, target,
        { secret: env.TURN_STREAM_AUTH_SECRET }))
      const id = env.HOST_TURNS.idFromString(target.hostId)
      return env.HOST_TURNS.get(id).fetch(new Request('https://fixture.internal/host-turn', { method: 'POST',
        headers: { 'content-type': 'application/json', [TURN_STREAM_TOKEN_HEADER]:
          await mintTurnStreamToken(turnHostChannelKey(target.hostId), env.TURN_STREAM_AUTH_SECRET) },
        body: JSON.stringify({ threadId: target.threadId, turnId: target.clientTurnId, content: 'Must not restart.' }),
      }))
    }
    return handleDurableStopTransport(request, env)
  },
}
