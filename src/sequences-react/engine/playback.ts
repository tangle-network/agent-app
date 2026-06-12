/**
 * rAF playback clock. The playhead is derived from a (start time, start
 * frame) anchor and `performance.now()` deltas — never from per-tick
 * increments — so dropped animation frames cannot accumulate drift.
 *
 * Browser-only at PLAY time, import-safe everywhere: `requestAnimationFrame`
 * and `performance` are resolved off `globalThis` when playback starts, never
 * at module load or construction, so server bundles that import the editor
 * engine do not crash.
 */

import type { PlaybackClock } from '../contracts'

export interface PlaybackClockConfig {
  fps: number
  durationFrames: number
}

interface RafGlobals {
  requestAnimationFrame?: (callback: (time: number) => void) => number
  cancelAnimationFrame?: (id: number) => void
  performance?: { now(): number }
}

function resolveRaf(): {
  request: (callback: (time: number) => void) => number
  cancel: (id: number) => void
} {
  const g = globalThis as RafGlobals
  if (typeof g.requestAnimationFrame !== 'function' || typeof g.cancelAnimationFrame !== 'function') {
    throw new Error(
      'PlaybackClock requires requestAnimationFrame/cancelAnimationFrame — playback runs only in a browser (or a test that stubs both globals)',
    )
  }
  return { request: g.requestAnimationFrame.bind(globalThis), cancel: g.cancelAnimationFrame.bind(globalThis) }
}

function now(): number {
  const perf = (globalThis as RafGlobals).performance
  if (!perf || typeof perf.now !== 'function') {
    throw new Error('PlaybackClock requires performance.now() — playback runs only in a browser (or a test that stubs it)')
  }
  return perf.now()
}

export function createPlaybackClock(config: PlaybackClockConfig): PlaybackClock {
  if (!Number.isInteger(config.fps) || config.fps <= 0) {
    throw new Error(`fps must be a positive integer, got ${config.fps}`)
  }
  if (!Number.isInteger(config.durationFrames) || config.durationFrames < 1) {
    throw new Error(`durationFrames must be a positive integer, got ${config.durationFrames}`)
  }
  const lastFrame = config.durationFrames - 1

  let frame = 0
  let playing = false
  let disposed = false
  let rafId: number | null = null
  let cancelRaf: ((id: number) => void) | null = null
  let anchorTime = 0
  let anchorFrame = 0
  const listeners = new Set<(frame: number) => void>()

  const notify = (): void => {
    for (const listener of [...listeners]) listener(frame)
  }

  const stopLoop = (): void => {
    if (rafId !== null && cancelRaf) cancelRaf(rafId)
    rafId = null
  }

  /** One callback per animation frame while playing; pauses on reaching the
   *  final frame. */
  const tick = (): void => {
    rafId = null
    if (!playing) return
    const elapsedMs = now() - anchorTime
    const advanced = anchorFrame + Math.floor((elapsedMs / 1000) * config.fps)
    if (advanced >= lastFrame) {
      frame = lastFrame
      playing = false
      notify()
      return
    }
    frame = advanced
    notify()
    rafId = resolveRaf().request(tick)
  }

  return {
    /** Idempotent while playing. Playing from the final frame restarts at 0 —
     *  a play button at the end means "watch again", not a dead control. */
    play(): void {
      if (disposed) throw new Error('PlaybackClock is disposed')
      if (playing) return
      const raf = resolveRaf()
      cancelRaf = raf.cancel
      if (frame >= lastFrame) frame = 0
      anchorTime = now()
      anchorFrame = frame
      playing = true
      rafId = raf.request(tick)
    },

    pause(): void {
      if (!playing) return
      playing = false
      stopLoop()
    },

    /** Clamps into [0, durationFrames - 1]; fractional input rounds to the
     *  nearest frame. Re-anchors mid-play so playback continues from the
     *  seek target, and notifies so scrubbing drives the playhead. */
    seek(target: number): void {
      if (disposed) throw new Error('PlaybackClock is disposed')
      if (!Number.isFinite(target)) throw new Error(`seek target must be a finite number, got ${target}`)
      frame = Math.max(0, Math.min(lastFrame, Math.round(target)))
      if (playing) {
        anchorTime = now()
        anchorFrame = frame
      }
      notify()
    },

    isPlaying(): boolean {
      return playing
    },

    getFrame(): number {
      return frame
    },

    subscribe(listener: (frame: number) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    dispose(): void {
      playing = false
      stopLoop()
      listeners.clear()
      disposed = true
    },
  }
}
