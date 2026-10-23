import type { TurnStreamAuth, TurnStreamNamespaceLike } from './adapters'
import { TURN_STREAM_PATHS, TURN_STREAM_TOKEN_HEADER, mintTurnStreamToken, turnLockChannelKey } from './core'
import type { TurnCancellationIdentity } from './cancellation-do'
export type { TurnCancellationIdentity } from './cancellation-do'

/** Per-owner observation only. Closing it never changes or releases the durable lock. */
export interface TurnCancellationConnection {
  signal: AbortSignal
  close(): void
}

interface ControlSocket extends EventTarget {
  accept(): void
  send(value: string): void
  close(code?: number, reason?: string): void
}

export class TurnCancellationRequestedError extends Error {
  readonly code = 'turn_cancel_requested'
  constructor() { super('Cancellation was requested for this turn'); this.name = 'TurnCancellationRequestedError' }
}

export class TurnControlUnavailableError extends Error {
  readonly code = 'turn_control_unavailable'
  constructor(message = 'The durable turn control connection was lost') { super(message); this.name = 'TurnControlUnavailableError' }
}

async function cancellationRequest(namespace: TurnStreamNamespaceLike, identity: TurnCancellationIdentity,
  auth: TurnStreamAuth, upgrade: boolean,
) {
  const key = turnLockChannelKey(identity.workspaceId, identity.threadId, identity.scope)
  const url = new URL(`https://turn-stream.internal${upgrade ? '/' : TURN_STREAM_PATHS.lockReleaseInterrupted}`)
  const headers = new Headers({ [TURN_STREAM_TOKEN_HEADER]: await mintTurnStreamToken(key, auth.secret, undefined, undefined,
    { purpose: upgrade ? 'turn-control' : 'turn-cancel', identity }) })
  if (upgrade) {
    for (const [name, value] of Object.entries(identity)) url.searchParams.set(name, value)
    url.searchParams.set('sessionId', identity.threadId)
    url.searchParams.set('cancellation', '1')
    headers.set('Upgrade', 'websocket')
  } else headers.set('Content-Type', 'application/json')
  return namespace.get(namespace.idFromName(key)).fetch(url.href, { method: upgrade ? 'GET' : 'POST', headers,
    ...(upgrade ? {} : { body: JSON.stringify({ ...identity, cancel: true }) }) })
}

/** The product authorizes Stop first. This exact fenced request records intent; it never claims work stopped. */
export async function requestDurableTurnCancellation(namespace: TurnStreamNamespaceLike, identity: TurnCancellationIdentity,
  auth: TurnStreamAuth,
): Promise<{ requested: boolean; reason?: 'stale-owner' }> {
  const response = await cancellationRequest(namespace, identity, auth, false)
  if (!response.ok) throw new Error(`Turn cancellation failed (HTTP ${response.status})`)
  return response.json()
}

/** One server-owned connection on the existing authenticated DO transport, with retained cancellation replay. */
export async function connectDurableTurnCancellation(namespace: TurnStreamNamespaceLike, identity: TurnCancellationIdentity,
  auth: TurnStreamAuth,
): Promise<TurnCancellationConnection> {
  const response = await cancellationRequest(namespace, identity, auth, true) as Response & { webSocket?: ControlSocket }
  if (response.status !== 101 || !response.webSocket) throw new TurnControlUnavailableError(`Turn control connection failed (HTTP ${response.status})`)
  const socket = response.webSocket
  const controller = new AbortController()
  let closing = false
  let ready = false
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const connected = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const fail = () => {
    if (closing) return
    const error = new TurnControlUnavailableError()
    if (!ready) rejectReady(error)
    controller.abort(error)
  }
  const close = () => { closing = true; clearTimeout(timer); try { socket.close(1000, 'Owner observation ended') } catch { /* Already closed. */ } }
  const timer = setTimeout(() => { if (!ready) { fail(); close() } }, 10_000)
  socket.addEventListener('message', event => {
    let message: { type?: string; cancellationRequested?: boolean }
    try { message = JSON.parse(String((event as MessageEvent).data)) } catch { fail(); close(); return }
    if (message.type === 'turn.control.released') {
      // A normal owner closes before its own cooperative release. Any release
      // still observed here removes this producer's authority to continue I/O.
      fail()
      close(); return
    }
    if (message.type === 'turn.control.ownership-lost') { fail(); close(); return }
    if (message.type !== 'turn.control' || typeof message.cancellationRequested !== 'boolean') { fail(); close(); return }
    if (message.cancellationRequested) controller.abort(new TurnCancellationRequestedError())
    ready = true
    clearTimeout(timer)
    resolveReady()
  })
  socket.addEventListener('close', fail)
  socket.addEventListener('error', fail)
  try { socket.accept(); socket.send(JSON.stringify({ type: 'sync' })); await connected }
  catch (error) { close(); throw error }
  return { signal: controller.signal, close }
}
