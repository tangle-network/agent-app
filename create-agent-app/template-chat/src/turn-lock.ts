import { TurnStreamDO as SharedTurnStreamDO, TURN_STREAM_STORAGE_KEYS, type DurableTurnLock } from '@tangle-network/agent-app/turn-stream'

/** A detached sandbox may outlive a Worker and the shared default lease.
 * Keep admission closed until cooperative release or an operator reconciles
 * the actual backend execution. Elapsed time alone never proves it stopped.
 * Auth, atomic admission, fencing and release remain owned by the shared DO.
 */
export class DetachedTurnStreamDO extends SharedTurnStreamDO {
  protected override async loadActiveLock(): Promise<DurableTurnLock | null> {
    return await this.state.storage.get<DurableTurnLock>(TURN_STREAM_STORAGE_KEYS.lock) ?? null
  }
}

// Preserve the generated Worker binding and its integration entrypoint.
export { DetachedTurnStreamDO as TurnStreamDO }
