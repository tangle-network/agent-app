/**
 * Adaptive timecode ruler. Tick density follows zoom through
 * `selectTickStepSeconds` (major ticks never closer than ~80px, minor ticks
 * at a fifth of the major step when they'd sit at least 8px apart). Click or
 * drag scrubs: the pointer is captured, every move quantizes to a whole frame,
 * and the frame is committed through `onScrub` (the editor routes it to
 * `PlaybackClock.seek`).
 */

import { useMemo } from 'react'
import type { PointerEvent } from 'react'
import { formatTimecode } from '../../sequences/model'
import { selectTickStepSeconds } from './interaction-math'

export interface TimelineRulerProps {
  fps: number
  durationFrames: number
  /** Pixels per frame. */
  zoom: number
  onScrub(frame: number): void
}

interface RulerTick {
  frame: number
  label: string | null
}

export function TimelineRuler({ fps, durationFrames, zoom, onScrub }: TimelineRulerProps) {
  const ticks = useMemo<RulerTick[]>(() => {
    const stepSeconds = selectTickStepSeconds({ zoom, fps })
    const majorStepFrames = stepSeconds * fps
    const minorStepFrames = Math.round(majorStepFrames / 5)
    const drawMinor = minorStepFrames * zoom >= 8 && minorStepFrames >= 1
    const result: RulerTick[] = []
    for (let frame = 0; frame <= durationFrames; frame += majorStepFrames) {
      result.push({ frame, label: formatTimecode(frame, fps) })
      if (!drawMinor) continue
      for (let minor = 1; minor < 5; minor += 1) {
        const minorFrame = frame + minor * minorStepFrames
        if (minorFrame >= durationFrames) break
        result.push({ frame: minorFrame, label: null })
      }
    }
    return result
  }, [durationFrames, fps, zoom])

  function frameFromPointer(event: PointerEvent<HTMLDivElement>): number {
    const rect = event.currentTarget.getBoundingClientRect()
    const frame = Math.round((event.clientX - rect.left) / zoom)
    return Math.max(0, Math.min(durationFrames, frame))
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    // Pointer capture is absent in non-browser test environments.
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    onScrub(frameFromPointer(event))
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (typeof event.currentTarget.hasPointerCapture !== 'function') return
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    onScrub(frameFromPointer(event))
  }

  return (
    <div
      data-timeline-ruler
      className="relative h-7 cursor-ew-resize select-none border-b border-[var(--border-default)] bg-[var(--bg-input)]"
      style={{ width: `${durationFrames * zoom}px`, touchAction: 'none' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
    >
      {ticks.map((tick) => (
        <div
          key={tick.frame}
          className={`absolute bottom-0 w-px bg-[var(--border-default)] ${tick.label !== null ? 'top-2.5' : 'top-[18px]'}`}
          style={{ left: `${tick.frame * zoom}px` }}
        >
          {tick.label !== null ? (
            <span className="absolute -top-2 left-1 whitespace-nowrap font-mono text-[10px] leading-none text-[var(--text-muted)]">
              {tick.label}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  )
}
