/**
 * Drag snapping. Snap points come from the timeline's structure (clip edges,
 * playhead, sequence end); the snap THRESHOLD is measured in screen pixels at
 * the current zoom — what feels "close" is a screen distance, not a frame
 * count — and converts to frames as thresholdPx / zoom.
 */

import type { SequenceTimeline } from '../../sequences/model'
import type { SnapPoint, SnapResult } from '../contracts'

/** Snap point with its owning clip when it came from one, so a drag can
 *  exclude the dragged clip's own edges. Structurally a `SnapPoint`. */
export interface TimelineSnapPoint extends SnapPoint {
  clipId?: string
}

/** Disabled clips still occupy timeline space visually, so their edges remain
 *  snap targets. */
export function collectSnapPoints(timeline: SequenceTimeline, playheadFrame: number): TimelineSnapPoint[] {
  if (!Number.isInteger(playheadFrame) || playheadFrame < 0) {
    throw new Error(`playheadFrame must be a non-negative integer, got ${playheadFrame}`)
  }
  const points: TimelineSnapPoint[] = []
  for (const clip of timeline.clips) {
    points.push({ frame: clip.startFrame, kind: 'clip-start', clipId: clip.id })
    points.push({ frame: clip.startFrame + clip.durationFrames, kind: 'clip-end', clipId: clip.id })
  }
  points.push({ frame: playheadFrame, kind: 'playhead' })
  points.push({ frame: timeline.sequence.durationFrames, kind: 'sequence-end' })
  return points.sort((a, b) => a.frame - b.frame || a.kind.localeCompare(b.kind))
}

/** Define options to configure snapping behavior including zoom, threshold, and exclusion criteria */
export interface ApplySnapOptions {
  /** Pixels per frame — converts the pixel threshold into frames. */
  zoom: number
  /** Screen-distance threshold; 10px matches the editor's hit-slop. */
  thresholdPx?: number
  /** Return true to remove a point from consideration (e.g. the dragged
   *  clip's own edges via `TimelineSnapPoint.clipId`). */
  exclude?: (point: SnapPoint) => boolean
}

/** Nearest candidate wins; ties keep the first candidate in `points` order
 *  (sorted by frame from `collectSnapPoints`, so the lower frame). */
export function applySnap(frame: number, points: SnapPoint[], opts: ApplySnapOptions): SnapResult {
  if (!Number.isFinite(frame)) throw new Error(`frame must be a finite number, got ${frame}`)
  if (!Number.isFinite(opts.zoom) || opts.zoom <= 0) {
    throw new Error(`zoom must be a positive finite number (pixels per frame), got ${opts.zoom}`)
  }
  const thresholdPx = opts.thresholdPx ?? 10
  if (!Number.isFinite(thresholdPx) || thresholdPx < 0) {
    throw new Error(`thresholdPx must be a non-negative finite number, got ${thresholdPx}`)
  }
  const thresholdFrames = thresholdPx / opts.zoom

  let best: SnapPoint | null = null
  let bestDistance = Infinity
  for (const point of points) {
    if (opts.exclude && opts.exclude(point)) continue
    const distance = Math.abs(point.frame - frame)
    if (distance < bestDistance) {
      best = point
      bestDistance = distance
    }
  }

  if (best !== null && bestDistance <= thresholdFrames) {
    return { frame: best.frame, snapped: true, point: best }
  }
  return { frame, snapped: false, point: null }
}
