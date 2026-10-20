import { useEffect, useRef, useState } from 'react'

/**
 * Guard an async action against double-submit. `run` ignores re-entrant calls
 * while a promise is in flight and flips `pending` so the caller can disable
 * the control — the fix for double-charge / double-approve on a slow network.
 * Settles (success or throw) before clearing, and no-ops state updates after
 * unmount.
 */
export function usePending(): { pending: boolean; run: (action: () => void | Promise<void>) => void } {
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const run = (action: () => void | Promise<void>) => {
    if (inFlight.current) return
    let result: void | Promise<void>
    try {
      result = action()
    } catch {
      return
    }
    if (!(result instanceof Promise)) return
    inFlight.current = true
    setPending(true)
    void result.finally(() => {
      inFlight.current = false
      if (mounted.current) setPending(false)
    })
  }
  return { pending, run }
}
