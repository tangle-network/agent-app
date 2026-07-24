/**
 * Smooth text reveal — turns chunky network deltas into a continuous
 * typewriter paint. Streamed turns arrive in 100-500ms slabs (model burst,
 * flush windows, replay polls); revealing characters at an adaptive rate
 * makes the same bytes read as top-tier streaming. The rate scales with the
 * backlog so the reveal never falls behind the stream — it crawls when caught
 * up and sprints when a burst lands (e.g. a reasoning summary arriving all at
 * once still *types out* instead of popping in).
 */

import { useEffect, useRef, useState } from 'react'

/** Define configuration options for controlling smooth text reveal animation rates */
export interface SmoothRevealOptions {
  /** Baseline reveal rate when nearly caught up. Default 90 chars/s. */
  baseCharsPerSecond?: number
  /** Extra chars/s per backlog character — the catch-up pressure. Default 5. */
  catchUpPerChar?: number
  /** Hard ceiling so giant bursts still animate. Default 2400 chars/s. */
  maxCharsPerSecond?: number
}

/** Pure reveal step: how many characters should be visible after `dtMs`.
 *  Exposed for tests; the hook is a thin rAF wrapper around it. */
export function nextRevealCount(
  shown: number,
  targetLength: number,
  dtMs: number,
  opts: SmoothRevealOptions = {},
): number {
  if (shown >= targetLength) return targetLength
  const base = opts.baseCharsPerSecond ?? 90
  const catchUp = opts.catchUpPerChar ?? 5
  const max = opts.maxCharsPerSecond ?? 2400
  const backlog = targetLength - shown
  const rate = Math.min(max, base + backlog * catchUp)
  return Math.min(targetLength, shown + (rate * dtMs) / 1000)
}

/**
 * Animate `target` text into view. While `enabled`, the returned string grows
 * smoothly toward `target` (which may itself keep growing); when `enabled` is
 * false the full text returns immediately (history, completed turns). A
 * target that is not an extension of the revealed prefix (new message) resets
 * the reveal.
 */
export function useSmoothText(target: string, enabled: boolean, opts?: SmoothRevealOptions): string {
  const [, force] = useState(0)
  const shownRef = useRef(0)
  const lastTargetRef = useRef('')

  // New message / rewritten prefix → restart the reveal from zero.
  if (!target.startsWith(lastTargetRef.current.slice(0, Math.floor(shownRef.current)))) {
    shownRef.current = 0
  }
  lastTargetRef.current = target
  if (!enabled) shownRef.current = target.length

  useEffect(() => {
    if (!enabled) return
    let raf = 0
    let last: number | null = null
    const tick = (t: number) => {
      const dt = last == null ? 16 : Math.min(t - last, 100)
      last = t
      const targetLen = lastTargetRef.current.length
      if (shownRef.current < targetLen) {
        shownRef.current = nextRevealCount(shownRef.current, targetLen, dt, opts)
        force((n) => n + 1)
        // Keep painting while there is still backlog to reveal.
        raf = requestAnimationFrame(tick)
      }
      // Caught up: stop the loop. A later `target` growth re-renders this hook
      // (target is read fresh below), and the next render's effect — re-run
      // because `target` is a dep — restarts the loop. Idle messages spawn no
      // rAF, so a full thread of completed turns is dormant.
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, target])

  return target.slice(0, Math.floor(shownRef.current))
}
