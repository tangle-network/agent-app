/**
 * Pure pointer-gesture math for the timeline editor. Every drag/trim/scrub
 * gesture quantizes through these functions so the interactive behavior is
 * unit-testable without a DOM. All inputs/outputs are integer frames except
 * pixel deltas and zoom (px per frame), which are the only float-valued edge.
 */

import { MIN_SEQUENCE_CLIP_FRAMES, clampClipStart } from '../../sequences/model'
import type { SnapPoint, SnapResult } from '../contracts'

/** Quantize a horizontal pointer delta to whole frames at the current zoom. */
export function framesFromPixelDelta(deltaX: number, zoom: number): number {
  if (!Number.isFinite(deltaX)) throw new Error('deltaX must be a finite pixel delta')
  if (!Number.isFinite(zoom) || zoom <= 0) throw new Error('zoom (pixels per frame) must be a positive finite number')
  return Math.round(deltaX / zoom)
}

export interface MoveDragInput {
  originStartFrame: number
  durationFrames: number
  deltaFrames: number
  sequenceDurationFrames: number
}

/** New start frame for a move drag, clamped so the clip stays fully inside
 *  the sequence. */
export function moveDragStartFrame(input: MoveDragInput): number {
  return clampClipStart({
    startFrame: input.originStartFrame + input.deltaFrames,
    durationFrames: input.durationFrames,
    sequenceDurationFrames: input.sequenceDurationFrames,
  })
}

export interface TrimStartDragInput {
  originStartFrame: number
  originDurationFrames: number
  originSourceInFrame: number
  deltaFrames: number
}

export interface TrimStartDragResult {
  startFrame: number
  durationFrames: number
  sourceInFrame: number
}

/**
 * Head trim: the clip END is invariant; start slides between two hard walls —
 * it cannot reveal media before source frame 0 (sourceInFrame >= 0) and cannot
 * pass within MIN_SEQUENCE_CLIP_FRAMES of the end. sourceInFrame shifts by
 * exactly the start delta so the visible content stays anchored.
 */
export function trimStartDrag(input: TrimStartDragInput): TrimStartDragResult {
  const endFrame = input.originStartFrame + input.originDurationFrames
  const minStart = Math.max(0, input.originStartFrame - input.originSourceInFrame)
  const maxStart = endFrame - MIN_SEQUENCE_CLIP_FRAMES
  const startFrame = Math.max(minStart, Math.min(maxStart, input.originStartFrame + input.deltaFrames))
  return {
    startFrame,
    durationFrames: endFrame - startFrame,
    sourceInFrame: input.originSourceInFrame + (startFrame - input.originStartFrame),
  }
}

export interface TrimEndDragInput {
  originStartFrame: number
  originDurationFrames: number
  sourceInFrame: number
  deltaFrames: number
  sequenceDurationFrames: number
  /** Natural source length in frames when known; bounds how far the tail can
   *  extend. Omit for stills and media of unknown length. */
  sourceDurationFrames?: number
}

/** Tail trim: start is invariant; duration is bounded below by the minimum
 *  clip length and above by both the sequence end and the remaining source
 *  material past the in-point. */
export function trimEndDrag(input: TrimEndDragInput): { durationFrames: number } {
  const bySequence = input.sequenceDurationFrames - input.originStartFrame
  const bySource = input.sourceDurationFrames === undefined
    ? Number.POSITIVE_INFINITY
    : input.sourceDurationFrames - input.sourceInFrame
  const maxDuration = Math.min(bySequence, bySource)
  const durationFrames = Math.max(
    MIN_SEQUENCE_CLIP_FRAMES,
    Math.min(maxDuration, input.originDurationFrames + input.deltaFrames),
  )
  return { durationFrames }
}

const TICK_STEPS_SECONDS = [1, 5, 10, 30, 60, 300] as const

/**
 * Smallest ruler step whose major ticks sit at least `minSpacingPx` apart at
 * the current zoom; past the table it grows in whole minutes so labels never
 * collide at extreme zoom-out.
 */
export function selectTickStepSeconds(input: { zoom: number; fps: number; minSpacingPx?: number }): number {
  if (!Number.isFinite(input.zoom) || input.zoom <= 0) throw new Error('zoom must be a positive finite number')
  if (!Number.isInteger(input.fps) || input.fps <= 0) throw new Error('fps must be a positive integer')
  const minSpacing = input.minSpacingPx ?? 80
  for (const step of TICK_STEPS_SECONDS) {
    if (step * input.fps * input.zoom >= minSpacing) return step
  }
  const pxPerMinute = 60 * input.fps * input.zoom
  return Math.ceil(minSpacing / pxPerMinute) * 60
}

export interface LetterboxRect {
  x: number
  y: number
  width: number
  height: number
}

/** Contain-fit a media aspect inside a container, centered with letterbox or
 *  pillarbox bars. */
export function letterboxRect(input: {
  containerWidth: number
  containerHeight: number
  mediaWidth: number
  mediaHeight: number
}): LetterboxRect {
  const { containerWidth, containerHeight, mediaWidth, mediaHeight } = input
  if (containerWidth <= 0 || containerHeight <= 0) throw new Error('container dimensions must be positive')
  if (mediaWidth <= 0 || mediaHeight <= 0) throw new Error('media dimensions must be positive')
  const scale = Math.min(containerWidth / mediaWidth, containerHeight / mediaHeight)
  const width = mediaWidth * scale
  const height = mediaHeight * scale
  return {
    x: (containerWidth - width) / 2,
    y: (containerHeight - height) / 2,
    width,
    height,
  }
}

/** Caption type scales with the rendered frame, floored so captions stay
 *  legible on small previews. */
export function captionFontPx(canvasCssHeight: number): number {
  if (!Number.isFinite(canvasCssHeight) || canvasCssHeight <= 0) throw new Error('canvas height must be positive')
  return Math.max(12, Math.round(canvasCssHeight / 18))
}

/** Pixel geometry for a clip chip; width floors at 2px so 1-frame clips stay
 *  grabbable. */
export function clipChipGeometry(input: { startFrame: number; durationFrames: number; zoom: number }): { left: number; width: number } {
  return {
    left: input.startFrame * input.zoom,
    width: Math.max(2, input.durationFrames * input.zoom),
  }
}

/**
 * A move drag snaps whichever clip edge lands closest to a snap point: the
 * start edge directly, or the end edge re-expressed as a start. An unsnapped
 * candidate passes through unchanged.
 */
export function chooseMoveSnap(input: {
  candidateStartFrame: number
  durationFrames: number
  startSnap: SnapResult
  endSnap: SnapResult
}): { startFrame: number; point: SnapPoint | null } {
  const startDelta = input.startSnap.snapped
    ? Math.abs(input.startSnap.frame - input.candidateStartFrame)
    : Number.POSITIVE_INFINITY
  const endStartFrame = input.endSnap.frame - input.durationFrames
  const endDelta = input.endSnap.snapped
    ? Math.abs(endStartFrame - input.candidateStartFrame)
    : Number.POSITIVE_INFINITY
  if (startDelta === Number.POSITIVE_INFINITY && endDelta === Number.POSITIVE_INFINITY) {
    return { startFrame: input.candidateStartFrame, point: null }
  }
  if (startDelta <= endDelta) return { startFrame: input.startSnap.frame, point: input.startSnap.point }
  return { startFrame: endStartFrame, point: input.endSnap.point }
}
