/**
 * workerd fixture for `durable-stop-reconnect-workers.integration.test.ts`: the shipped TurnStreamDO with two control
 * socket faults, and the shipped durable turn lock with Stop (`createDurableTurnLock` with `cancellationOf`) driven
 * through each. One scenario per request, each on its own workspace's object.
 */
import { createDurableTurnLock, type TurnStreamNamespaceLike } from '../../src/turn-stream/adapters'
import { requestDurableTurnCancellation } from '../../src/turn-stream/cancellation'
import { mintTurnStreamToken, TURN_STREAM_TOKEN_HEADER, turnLockChannelKey, type TurnLockReleaseInput } from '../../src/turn-stream/core'
import { TurnStreamDO } from '../../src/turn-stream/do'

interface Env { TURN_STREAM_DO: TurnStreamNamespaceLike; TURN_STREAM_AUTH_SECRET: string }

export class FaultTurnStreamDO extends TurnStreamDO {
  /** `/fault/unanswered-sync` leaves the next control sync unanswered: the owner's socket is open but never synced. */
  async webSocketMessage(...args: Parameters<TurnStreamDO['webSocketMessage']>): Promise<void> {
    if (await this.state.storage.get('fault:unanswered-sync')) {
      await this.state.storage.delete('fault:unanswered-sync')
      return
    }
    return super.webSocketMessage(...args)
  }

  protected async handleProductRequest(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname === '/fault/unanswered-sync') {
      await this.state.storage.put('fault:unanswered-sync', true)
      return Response.json({ ok: true })
    }
    // Every open control socket drops under its owner while the lock stays held.
    if (url.pathname === '/fault/drop') {
      for (const socket of this.state.getWebSockets()) socket.close(1011, 'Fixture transport loss')
      return Response.json({ ok: true })
    }
    return super.handleProductRequest(request, url)
  }
}

const reasonCode = (signal: AbortSignal) => signal.aborted ? String((signal.reason as { code?: unknown })?.code ?? signal.reason) : null
/** Resolves when the signal aborts, or after `ms`. */
const settle = (signal: AbortSignal, ms: number) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve()
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const scenario = new URL(request.url).pathname.slice(1)
    const tenantId = `workspace-${scenario}`
    const auth = { secret: env.TURN_STREAM_AUTH_SECRET }
    const lock = createDurableTurnLock<null>({ namespace: env.TURN_STREAM_DO, auth, scopeOf: () => 'workspace', cancellationOf: () => true })
    const key = turnLockChannelKey(tenantId, scenario, 'workspace')
    const fault = async (path: string) => {
      const response = await env.TURN_STREAM_DO.get(env.TURN_STREAM_DO.idFromName(key)).fetch(`https://turn-stream.internal${path}`,
        { method: 'POST', headers: { [TURN_STREAM_TOKEN_HEADER]: await mintTurnStreamToken(key, auth.secret) } })
      if (!response.ok) throw new Error(`fault ${path}: HTTP ${response.status}`)
    }
    const args = { identity: { tenantId, sessionId: scenario }, executionId: `execution-${scenario}`, turnStreamId: `stream-${scenario}`,
      context: null, body: { turnId: `turn-${scenario}` } }

    if (scenario === 'unanswered-sync') await fault('/fault/unanswered-sync')
    const started = Date.now()
    const outcome = await lock.acquire(args).then(value => ({ value }), (error: unknown) => ({ error }))
    if ('error' in outcome) {
      return Response.json({ acquired: false, error: String((outcome.error as { code?: unknown })?.code ?? outcome.error), ms: Date.now() - started })
    }
    const acquired = outcome.value
    if (!acquired.acquired || !acquired.cancellation) return Response.json({ acquired: false, error: 'no durable Stop' })
    const cancellation = acquired.cancellation
    const handle = acquired.handle
    const identity = { ...(handle as TurnLockReleaseInput), turnStreamId: args.turnStreamId }
    const result: Record<string, unknown> = { acquired: true, ms: Date.now() - started }

    if (scenario !== 'unanswered-sync') await fault('/fault/drop')
    // Stop while the owner is between sockets: the object records it, and the owner's next sync must deliver it.
    if (scenario === 'drop-then-stop') await requestDurableTurnCancellation(env.TURN_STREAM_DO, identity, auth)
    // The lock is released under the owner: no reconnect may keep the turn running.
    if (scenario === 'drop-then-release') await lock.release(handle)
    await settle(cancellation.signal, 4_000)
    result.afterDrop = reasonCode(cancellation.signal)
    if (scenario === 'drop') {
      // A Stop after the owner reconnected reaches it on its new socket.
      await requestDurableTurnCancellation(env.TURN_STREAM_DO, identity, auth)
      await settle(cancellation.signal, 4_000)
      result.afterStop = reasonCode(cancellation.signal)
    }
    cancellation.close()
    if (scenario !== 'drop-then-release') await lock.release(handle)
    return Response.json(result)
  },
}
