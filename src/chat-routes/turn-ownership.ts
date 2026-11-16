import type { AssistantDraftWriter } from './draft-persistence'
import type { NativeCompletionHandoffOptions, NativeTimingTransfer } from './native-turn-timing'
import { DEFAULT_RUNNING_TURN_RENEW_INTERVAL_MS, type BufferedTurnTap, type TurnEventStore } from '../stream/index'
import type { ChatTurnLock, ChatTurnRouteProducer } from './turn-route-contracts'

interface OwnershipState {
  producer?: ChatTurnRouteProducer
  completionHandoff: boolean
  completionHandoffPromise: Promise<void> | undefined
  nativeTiming: NativeTimingTransfer | undefined
  tap: BufferedTurnTap | undefined
  draft: AssistantDraftWriter | undefined
  lockAcquired: boolean
  lockReleased: boolean
  lockHandle: unknown
  closeCancellation?: () => Promise<void>
}

/** One transfer of terminal authority, retaining the route only as a live projector. */
export function createChatTurnOwnership(state: OwnershipState,
  log: (message: string, meta?: Record<string, unknown>) => void, turnStreamId: string,
  options: { turnLock?: Pick<ChatTurnLock<unknown>, 'release' | 'park' | 'holdForHandoff'>; turnStore?: Pick<TurnEventStore, 'setStatus'> },
  scopeId?: string,
) {
  // A cleanup step that fails is logged and never stops the steps after it.
  const attempt = async (step: string, run: () => unknown): Promise<void> => {
    try { await run() } catch (err) { log(`[chat-routes] ${step} failed`, { turnId: turnStreamId, error: err instanceof Error ? err.message : String(err) }) }
  }
  // The running row a lock reclaim reads: written at acquire and renewed on the tap's interval, so a turn still in
  // `contextGate` or `beforeTurn` holds its lock; it stops when the tap takes the row over, at hand-off, or at release.
  let runningRow: Promise<void> | undefined
  let renewal: ReturnType<typeof setInterval> | undefined
  const markRunning = () => {
    const write = () => (runningRow = options.turnStore?.setStatus(turnStreamId, 'running', scopeId))
    const first = write()
    renewal = setInterval(() => void write()?.catch(() => {}), DEFAULT_RUNNING_TURN_RENEW_INTERVAL_MS)
    return first
  }
  const stopRenewal = async (): Promise<void> => {
    clearInterval(renewal)
    renewal = undefined
    await runningRow?.catch(() => {}) // a late `running` write must not land over what follows
  }
  const handoffCompletion = (handoff?: NativeCompletionHandoffOptions): Promise<void> => {
    if (!state.completionHandoffPromise) {
      state.completionHandoffPromise = (async () => {
        // Product registration already owns this turn. A callback failure must never
        // restore the route's terminal authority or permit a second settlement.
        state.completionHandoff = true
        await stopRenewal()
        // A lock whose reclaim would read the handed-off turn as dead once nothing renews its row holds for the owner,
        // whose release of the exact lock frees it.
        if (state.lockAcquired && options.turnLock?.holdForHandoff) {
          const held = await Promise.resolve().then(() => options.turnLock!.holdForHandoff!(state.lockHandle)).catch(() => false)
          if (!held) log('[chat-routes] turn lock hand-off hold failed', { turnId: turnStreamId, class: 'turn_lock_handoff_hold_failed' })
        }
        let registrationFailed = false
        try {
          await state.nativeTiming?.register(handoff)
        } catch (error) {
          registrationFailed = true
          throw error
        } finally {
          await attempt('turn buffer detach', () => state.tap?.detach())
          try {
            await state.draft?.close()
          } catch (err) {
            if (!registrationFailed) throw err
            log('[chat-routes] draft close failed after native timing refusal', { turnId: turnStreamId,
              error: err instanceof Error ? err.message : String(err) })
          } finally {
            await state.closeCancellation?.()
          }
        }
      })()
    }
    return state.completionHandoffPromise
  }
  const releaseLock = async (): Promise<void> => {
    if (state.completionHandoff || !state.lockAcquired || state.lockReleased) return
    // Losing the live observation is not evidence that a detached backend stopped.
    // The exact execution stays fenced; a parked intent lets its durable owner release it once proven.
    if (state.producer?.terminalObserved && !state.producer.terminalObserved()) {
      await attempt('turnLock.park', () => options.turnLock?.park?.(state.lockHandle))
      await state.closeCancellation?.()
      return
    }
    state.lockReleased = true
    // Expected cooperative completion must not interpret its own release as
    // external loss of execution authority. A close failure must not skip release.
    await attempt('turn cancellation close', () => state.closeCancellation?.())
    await attempt('turnLock.release', () => options.turnLock!.release(state.lockHandle))
  }
  /** Release a turn that never reached its drain, settling its running row with `end` first: through the tap's own
   *  close when the tap exists, else directly. A gate's hand-off leaves the row to the product's owner. */
  const releaseBeforeDrain = async (end: 'complete' | 'error' | 'handoff'): Promise<void> => {
    await stopRenewal()
    if (end !== 'handoff' && !state.completionHandoff) {
      if (state.tap) await attempt('turn buffer close', () => state.tap!.done(end))
      else if (state.lockAcquired) await attempt('running row settle', () => options.turnStore?.setStatus(turnStreamId, end, scopeId))
    }
    await releaseLock()
  }
  return { handoffCompletion, releaseLock, markRunning, stopRenewal, releaseBeforeDrain }
}
