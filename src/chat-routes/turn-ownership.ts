import type { AssistantDraftWriter } from './draft-persistence'
import type { NativeCompletionHandoffOptions, NativeTimingTransfer } from './native-turn-timing'
import type { BufferedTurnTap } from '../stream/index'
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
  options: { turnLock?: Pick<ChatTurnLock<unknown>, 'release'> },
) {
  const handoffCompletion = (handoff?: NativeCompletionHandoffOptions): Promise<void> => {
    if (!state.completionHandoffPromise) {
      state.completionHandoffPromise = (async () => {
        // Product registration already owns this turn. A callback failure must never
        // restore the route's terminal authority or permit a second settlement.
        state.completionHandoff = true
        let registrationFailed = false
        try {
          await state.nativeTiming?.register(handoff)
        } catch (error) {
          registrationFailed = true
          throw error
        } finally {
          try {
            await state.tap?.detach()
          } catch (err) {
            log('[chat-routes] turn buffer detach failed', { turnId: turnStreamId,
              error: err instanceof Error ? err.message : String(err) })
          }
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
    // The exact execution stays fenced until its durable owner reconciles it.
    if (state.producer?.terminalObserved && !state.producer.terminalObserved()) {
      await state.closeCancellation?.()
      return
    }
    state.lockReleased = true
    // Expected cooperative completion must not interpret its own release as
    // external loss of execution authority. A close failure must not skip release.
    try { await state.closeCancellation?.() }
    catch (err) { log('[chat-routes] turn cancellation close failed', { turnId: turnStreamId,
      error: err instanceof Error ? err.message : String(err) }) }
    try {
      await options.turnLock!.release(state.lockHandle)
    } catch (err) {
      log('[chat-routes] turnLock.release failed', { turnId: turnStreamId,
        error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { handoffCompletion, releaseLock }
}
