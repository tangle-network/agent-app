import type { DurableTurnLock, TurnLockReleaseInput } from './core'
import type { TurnStreamDOState, TurnStreamSocket } from './do'

/** One cancellable turn, including the lock generation that grants its producer authority. */
export interface TurnCancellationIdentity extends TurnLockReleaseInput {
  turnStreamId: string
}

export interface TurnCancellationSocketMeta {
  sessionId: string
  scope: 'thread' | 'workspace'
  synced: boolean
  cancellation?: TurnCancellationIdentity
}

export function readTurnCancellationIdentity(value: Record<string, unknown>): TurnCancellationIdentity | null {
  const keys = ['workspaceId', 'threadId', 'executionId', 'lockId', 'turnStreamId'] as const
  if (keys.some(key => typeof value[key] !== 'string' || !String(value[key]).trim())) return null
  if (value.scope !== 'thread' && value.scope !== 'workspace') return null
  return { workspaceId: String(value.workspaceId), threadId: String(value.threadId), executionId: String(value.executionId),
    lockId: String(value.lockId), turnStreamId: String(value.turnStreamId), scope: value.scope }
}

function matches(lock: DurableTurnLock | null, input: TurnCancellationIdentity): lock is DurableTurnLock {
  return Boolean(lock && lock.workspaceId === input.workspaceId && lock.threadId === input.threadId && lock.scope === input.scope
    && lock.executionId === input.executionId && lock.lockId === input.lockId && lock.cancellation?.turnStreamId === input.turnStreamId)
}

/** Storage and hibernatable sockets belong to the existing lock DO; this helper never schedules or releases work. */
export class DurableTurnCancellation {
  constructor(private readonly state: TurnStreamDOState,
    private readonly readLock: (input: TurnCancellationIdentity) => Promise<DurableTurnLock | null>,
    private readonly writeLock: (lock: DurableTurnLock) => Promise<void>,
  ) {}

  async owns(input: TurnCancellationIdentity): Promise<boolean> {
    return matches(await this.readLock(input), input)
  }

  permitsRecovery(lock: DurableTurnLock, input: TurnCancellationIdentity): boolean {
    if (!matches(lock, input)) return false
    // An upgraded connection already fences recovery during setup; do not require its first sync.
    return !this.state.getWebSockets().some(socket => {
      const meta = socket.deserializeAttachment() as TurnCancellationSocketMeta | null
      const state = (socket as TurnStreamSocket & { readyState?: number }).readyState
      return meta?.cancellation && matches(lock, meta.cancellation) && (state === undefined || state === 0 || state === 1)
    })
  }

  async request(input: TurnCancellationIdentity): Promise<{ requested: boolean; reason?: 'stale-owner' }> {
    const lock = await this.readLock(input)
    if (!matches(lock, input)) return { requested: false, reason: 'stale-owner' }
    if (lock.cancellation!.requestedAt === undefined) {
      lock.cancellation = { turnStreamId: input.turnStreamId, requestedAt: Date.now() }
      // Await the durable fact before any socket sees it. A pre-connect Stop is replayed by sync.
      await this.writeLock(lock)
    }
    for (const socket of this.state.getWebSockets()) {
      const meta = socket.deserializeAttachment() as TurnCancellationSocketMeta | null
      if (meta?.synced && meta.cancellation && matches(lock, meta.cancellation)) this.send(socket, lock)
    }
    return { requested: true }
  }

  async sync(socket: TurnStreamSocket, meta: TurnCancellationSocketMeta): Promise<void> {
    const identity = meta.cancellation!
    // Become live before awaiting storage. A concurrent Stop is then delivered live,
    // by replay below, or both; AbortSignal cancellation is idempotent.
    socket.serializeAttachment({ ...meta, synced: true })
    const lock = await this.readLock(identity)
    if (!matches(lock, identity)) { socket.close(1008, 'Turn ownership changed'); return }
    this.send(socket, lock)
  }

  released(lock: DurableTurnLock): void { this.close(lock, false) }
  expired(lock: DurableTurnLock): void { this.close(lock, true) }

  private close(lock: DurableTurnLock, ownershipLost: boolean): void {
    for (const socket of this.state.getWebSockets()) {
      const meta = socket.deserializeAttachment() as TurnCancellationSocketMeta | null
      if (!meta?.cancellation || !matches(lock, meta.cancellation)) continue
      try { socket.send(JSON.stringify({ type: ownershipLost ? 'turn.control.ownership-lost' : 'turn.control.released' })); socket.close(1000, 'Turn settled') } catch { /* Already disconnected. */ }
    }
  }

  private send(socket: TurnStreamSocket, lock: DurableTurnLock): void {
    try { socket.send(JSON.stringify({ type: 'turn.control', cancellationRequested: lock.cancellation!.requestedAt !== undefined })) }
    catch { /* The durable request survives a disconnected owner. */ }
  }
}
