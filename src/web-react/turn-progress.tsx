/**
 * The status line of a turn that has not answered yet: the stage the server
 * reports on its `session.run.phase` events (`../chat-routes/turn-progress`)
 * and the seconds since the turn was sent.
 *
 * Every label comes from the server; the component only adds `pendingMessage`
 * for the moment between send and the first stage, while the request is in
 * flight.
 */

import { useEffect, useState } from 'react'
import { TextShimmer } from '@tangle-network/ui/primitives'
import type { TurnPhaseData } from '../chat-routes/turn-progress'

/** Seconds after which the elapsed time is shown beside the stage. */
const ELAPSED_VISIBLE_FROM_SECONDS = 3

/** Props for {@link TurnProgress}. */
export interface TurnProgressProps {
  /** The turn's latest stage. `null` or `undefined` until the first one arrives. */
  phase: Pick<TurnPhaseData, 'message'> | null | undefined
  /** Shown while the request is in flight and no stage has arrived. */
  pendingMessage?: string
  /** When the turn was sent (epoch ms). Defaults to when this line mounted. */
  startedAt?: number
  /** Show the elapsed seconds. Default true; a product turns it off once output is streaming. */
  showElapsed?: boolean
  className?: string
}

/** Live stage and elapsed seconds for a turn that has not produced output yet. */
export function TurnProgress({ phase, pendingMessage = 'Sending…', startedAt, showElapsed = true, className }: TurnProgressProps) {
  const [mountedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const seconds = Math.max(0, Math.floor((now - (startedAt ?? mountedAt)) / 1000))
  const message = phase?.message?.trim() || pendingMessage
  return (
    <div
      role="status"
      aria-live="polite"
      className={['flex min-w-0 items-center gap-2 text-sm text-muted-foreground', className].filter(Boolean).join(' ')}
    >
      <TextShimmer className="min-w-0 truncate">{message}</TextShimmer>
      {showElapsed && seconds >= ELAPSED_VISIBLE_FROM_SECONDS && (
        <span aria-hidden className="shrink-0 tabular-nums">{seconds}s</span>
      )}
    </div>
  )
}
