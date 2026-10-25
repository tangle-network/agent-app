import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComposerPlanModeSelection } from './composer-mode-controls'

/** Options for the per-thread plan-mode toggle. */
export interface UsePlanModeSelectionOptions {
  /** PATCH target for a thread's `{ planMode }`; defaults to `/api/threads/:id`. */
  threadUrl?: (threadId: string) => string
}

/**
 * Per-THREAD plan-mode toggle for `ComposerModeControls`. Persists through
 * `PATCH <threadUrl> { planMode }`. With no `threadId` (a new chat that has no
 * thread yet) it is local state only; the product carries the value into the
 * first send.
 *
 * Optimistic flip, rolled back if the PATCH fails or throws unless a newer
 * toggle superseded it; a loader resync is ignored while a save is in flight
 * so a stale revalidation cannot undo the click.
 */
export function usePlanModeSelection(
  threadId: string | undefined,
  initialPlanMode: boolean,
  options: UsePlanModeSelectionOptions = {},
): Required<ComposerPlanModeSelection> {
  const [value, setValueState] = useState(initialPlanMode)
  const [saving, setSaving] = useState(false)
  const inFlightRef = useRef(0)
  const seqRef = useRef(0)
  const { threadUrl } = options

  useEffect(() => {
    if (inFlightRef.current === 0) setValueState(initialPlanMode)
  }, [initialPlanMode])

  const update = useCallback(
    async (next: boolean) => {
      const prev = value
      if (next === prev) return
      const seq = ++seqRef.current
      setValueState(next)
      if (!threadId) return
      inFlightRef.current += 1
      setSaving(true)
      try {
        const url = threadUrl?.(threadId) ?? `/api/threads/${encodeURIComponent(threadId)}`
        const res = await fetch(url, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planMode: next }),
        })
        if (!res.ok && seqRef.current === seq) setValueState(prev)
      } catch {
        if (seqRef.current === seq) setValueState(prev)
      } finally {
        inFlightRef.current -= 1
        setSaving(inFlightRef.current > 0)
      }
    },
    [threadId, threadUrl, value],
  )

  return { enabled: value, setEnabled: (next: boolean) => void update(next), saving }
}
