/** Control of one live host invocation, including its detached drain and disposal. */
import type { ChatTurnRequestContext } from '../chat-routes/turn-route-contracts'
import type { TurnHostControlTarget } from '../chat-routes/turn-progress'
import {
  connectHostedTurnCancellation, TurnCancellationRequestedError, TurnControlUnavailableError,
  type TurnCancellationConnection,
} from './cancellation'
import { TURN_STREAM_TOKEN_HEADER } from './core'
import type { TurnStreamDOState, TurnStreamSocket } from './do'

const HOST_CONTROL_KEYS = ['hostId', 'workspaceId', 'threadId', 'clientTurnId', 'retryAttemptId'] as const

interface HostInvocation {
  controller: AbortController
  target?: TurnHostControlTarget
  pending: number
  connection?: TurnCancellationConnection
}

/** No admission ledger or restart: the DO still authenticates requests and owns its sockets/storage. */
export class HostedTurn {
  private started = false
  private invocation?: HostInvocation

  constructor(private readonly state: TurnStreamDOState) {}

  async run(request: Request,
    turn: (request: Request, ctx: ChatTurnRequestContext & { hosted: true }) => Promise<Response>,
  ): Promise<Response> {
    if (this.started) return Response.json({ error: 'This host invocation already started' }, { status: 409 })
    this.started = true
    const invocation: HostInvocation = { controller: new AbortController(), pending: 1 }
    this.invocation = invocation
    const finish = () => {
      if (--invocation.pending !== 0) return
      this.invocation = undefined
      invocation.connection?.close()
      invocation.controller.abort(new TurnControlUnavailableError('The host invocation ended'))
      // Reset may already have closed these sockets and fenced this old instance.
      try {
        for (const socket of this.state.getWebSockets()) socket.close(1000, 'Host invocation ended')
      } catch { /* The invocation's permission is already revoked. */ }
    }
    const waitUntil = (promise: Promise<unknown>) => {
      invocation.pending++
      const tracked = promise.finally(finish)
      this.state.waitUntil?.(tracked)
      void tracked.catch(() => {})
    }
    const headers = new Headers(request.headers)
    headers.delete(TURN_STREAM_TOKEN_HEADER)
    try {
      return await turn(new Request(request, { headers }), {
        waitUntil, hosted: true, hostControl: {
          hostId: String(this.state.id), signal: invocation.controller.signal,
          bind: async (target, owner) => {
            if (invocation.target || target.hostId !== String(this.state.id) || invocation.controller.signal.aborted) {
              throw new TurnControlUnavailableError('The host identity cannot be rebound')
            }
            invocation.target = { ...target }
            const connection = await connectHostedTurnCancellation(owner.namespace, target, owner.auth)
            invocation.connection = connection
            const lost = () => invocation.controller.abort(connection.signal.reason)
            if (connection.signal.aborted) lost()
            else connection.signal.addEventListener('abort', lost, { once: true })
          },
        },
      })
    } finally { finish() }
  }

  requestCancellation(input: Record<string, unknown> | null): { requested: boolean; reason?: 'stale-host' } {
    const invocation = this.invocation
    const target = invocation?.target
    if (!input || !invocation || !target || HOST_CONTROL_KEYS
      .some(key => input[key] !== target[key])) return { requested: false, reason: 'stale-host' }
    invocation.controller.abort(new TurnCancellationRequestedError())
    for (const socket of this.state.getWebSockets()) {
      try { socket.send(JSON.stringify({ type: 'turn.control', cancellationRequested: true })) }
      catch { /* Its owner connection fails closed on socket loss. */ }
    }
    return { requested: true }
  }

  controlTarget(url: URL): TurnHostControlTarget | undefined {
    const target = this.invocation?.target
    return target && !HOST_CONTROL_KEYS.some(key => (url.searchParams.get(key) ?? undefined) !== target[key])
      ? target : undefined
  }

  sync(ws: TurnStreamSocket, message: string | ArrayBuffer, host: TurnHostControlTarget): void {
    let type: unknown
    try { type = (JSON.parse(typeof message === 'string' ? message : '') as { type?: unknown }).type }
    catch { ws.close(1008, 'Invalid host control sync'); return }
    if (type !== 'sync') return
    const invocation = this.invocation
    if (!invocation?.target || HOST_CONTROL_KEYS.some(key => invocation.target![key] !== host[key])) {
      ws.close(1008, 'Host invocation changed'); return
    }
    ws.send(JSON.stringify({ type: 'turn.control', cancellationRequested: invocation.controller.signal.aborted }))
  }
}
