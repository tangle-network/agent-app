/** Serializable route observations transferred to the existing native admission owner. */
import type { NativeTurnTimingFacts } from '../turn-trace/turn-facts'
export type { NativeTurnTimingFacts } from '../turn-trace/turn-facts'

export interface NativeCompletionHandoffOptions {
  /** Persist on the existing admission, keyed by turnStreamId. Initial origin must survive before handoff. */
  persistTimingFacts?(facts: NativeTurnTimingFacts): Promise<void>
}

export interface NativeTimingTransfer {
  snapshot(): NativeTurnTimingFacts
  register(options?: NativeCompletionHandoffOptions): Promise<void>
  note(): Promise<void>
  flush(): Promise<void>
}

/** Initial registration is fail-closed. Later observations are serialized and waitUntil-tracked by the route. */
export function createNativeTimingTransfer(
  read: () => NativeTurnTimingFacts,
  onError: (error: unknown) => void,
): NativeTimingTransfer {
  let persist: NativeCompletionHandoffOptions['persistTimingFacts']
  let pending = Promise.resolve()
  return {
    snapshot: () => ({ ...read() }),
    async register(options) {
      if (!options?.persistTimingFacts) return
      await options.persistTimingFacts({ ...read() })
      persist = options.persistTimingFacts
    },
    note() {
      if (!persist) return pending
      const snapshot = { ...read() }
      const write = persist
      pending = pending.then(() => write(snapshot)).catch(onError)
      return pending
    },
    flush: () => pending,
  }
}
