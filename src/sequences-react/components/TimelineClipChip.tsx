/**
 * One clip on a track lane. Owns the pointer gestures that edit it:
 *
 * - body drag        → move (horizontal frames + vertical retarget onto another
 *                       unlocked track of the same kind)
 * - edge handles     → head/tail trim, clamped to MIN_SEQUENCE_CLIP_FRAMES and
 *                       the source material bounds
 * - double-click     → inline caption text edit (caption clips only)
 *
 * Gesture discipline: pointer capture on gesture start, every move quantizes
 * to whole frames, Escape restores the pre-drag state without emitting, and a
 * completed gesture commits EXACTLY ONCE through the `onCommit*` callbacks —
 * the editor turns that into one command on the stack (one undo step). The
 * chip never writes timeline state itself; until commit it renders a local
 * preview only.
 *
 * Vertical retarget reads lane geometry captured at gesture start (rects of
 * every `[data-lane-track]` under the editor's `[data-timeline-tracks]` root),
 * so the moving chip itself can never occlude the hit test.
 */

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { formatTimecode } from '../../sequences/model'
import type { SequenceClip, SequenceTrack, SequenceTrackKind } from '../../sequences/model'
import type { SnapPoint, VideoFrameProvider, WaveformData } from '../contracts'
import { loadWaveform, drawWaveform } from '../media/waveform'
import {
  clipChipGeometry,
  framesFromPixelDelta,
  moveDragStartFrame,
  trimEndDrag,
  trimStartDrag,
} from './interaction-math'

export interface ClipMoveCommit {
  clipId: string
  startFrame: number
  trackId: string
}

export interface ClipTrimCommit {
  clipId: string
  startFrame: number
  durationFrames: number
  sourceInFrame: number
}

export interface TimelineClipChipProps {
  clip: SequenceClip
  track: SequenceTrack
  fps: number
  /** Pixels per frame. */
  zoom: number
  sequenceDurationFrames: number
  selected: boolean
  canWrite: boolean
  /** Roving-tabindex: exactly one chip per editor carries tabIndex 0 so the
   *  clip set is a single Tab stop; arrows move focus across the others. */
  tabbable: boolean
  frameProvider: VideoFrameProvider
  /** Snap a candidate move (both clip edges considered); editor closes over
   *  the engine's snap points. */
  snapMove(candidate: { startFrame: number; durationFrames: number; clipId: string }): { startFrame: number; point: SnapPoint | null }
  /** Snap a single trim edge. */
  snapEdge(candidate: { frame: number; clipId: string }): { frame: number; point: SnapPoint | null }
  onSnapPointChange(point: SnapPoint | null): void
  onSelect(clipId: string, additive: boolean): void
  /** Keyboard delete of the focused clip (one command on the stack), routed
   *  through the same locked-track guard as the transport Delete key. */
  onRequestDelete(clipId: string): void
  /** Move keyboard focus to the previous/next clip in DOM order (roving
   *  tabindex); the editor owns the ordered chip set. */
  onFocusStep(clipId: string, direction: -1 | 1): void
  onCommitMove(input: ClipMoveCommit): void
  onCommitTrim(input: ClipTrimCommit): void
  onCommitText(input: { clipId: string; text: string }): void
}

type GestureKind = 'move' | 'trim-start' | 'trim-end'

interface LaneTarget {
  trackId: string
  top: number
  bottom: number
  offsetY: number
}

interface GestureState {
  kind: GestureKind
  pointerId: number
  originClientX: number
  origin: { startFrame: number; durationFrames: number; sourceInFrame: number }
  /** Same-kind unlocked lanes, captured once at gesture start. */
  laneTargets: LaneTarget[]
  originTrackId: string
}

interface GesturePreview {
  startFrame: number
  durationFrames: number
  sourceInFrame: number
  trackId: string
  translateY: number
  moved: boolean
}

const KIND_TONES: Record<SequenceTrackKind, string> = {
  video: 'border-sky-400/40 bg-sky-500/15',
  audio: 'border-emerald-400/40 bg-emerald-500/15',
  caption: 'border-amber-400/40 bg-amber-500/15',
  reference: 'border-zinc-400/40 bg-zinc-500/15',
  agent: 'border-violet-400/40 bg-violet-500/15',
}

/** Spec'd cache key is the clip id: a clip's waveform survives re-renders and
 *  zoom changes; a different clip with the same media decodes independently. */
const waveformCache = new Map<string, Promise<WaveformData>>()
const WAVEFORM_BUCKETS = 256

function sourceDurationFrames(clip: SequenceClip, fps: number): number | undefined {
  if (clip.sourceOutFrame !== null && clip.sourceOutFrame !== undefined) return clip.sourceOutFrame
  if (clip.media?.durationSeconds !== undefined) return Math.round(clip.media.durationSeconds * fps)
  return undefined
}

export function TimelineClipChip(props: TimelineClipChipProps) {
  const { clip, track, fps, zoom, selected, canWrite, tabbable, frameProvider } = props
  const rootRef = useRef<HTMLDivElement | null>(null)
  const gestureRef = useRef<GestureState | null>(null)
  const [preview, setPreview] = useState<GesturePreview | null>(null)
  /** Mirror of `preview` readable inside pointerup before React flushes the
   *  last pointermove's state update. */
  const previewRef = useRef<GesturePreview | null>(null)
  const [editingText, setEditingText] = useState<string | null>(null)
  const posterRef = useRef<HTMLCanvasElement | null>(null)
  const waveformRef = useRef<HTMLCanvasElement | null>(null)

  const shown = preview ?? {
    startFrame: clip.startFrame,
    durationFrames: clip.durationFrames,
    sourceInFrame: clip.sourceInFrame,
    trackId: clip.trackId,
    translateY: 0,
    moved: false,
  }
  const geometry = clipChipGeometry({ startFrame: shown.startFrame, durationFrames: shown.durationFrames, zoom })
  const interactive = canWrite && !track.locked

  // -------------------------------------------------------------------------
  // Gestures
  // -------------------------------------------------------------------------

  function collectLaneTargets(): LaneTarget[] {
    const root = rootRef.current?.closest('[data-timeline-tracks]')
    const originLane = rootRef.current?.closest('[data-lane-track]')
    if (!root || !originLane) return []
    const originTop = originLane.getBoundingClientRect().top
    const targets: LaneTarget[] = []
    for (const lane of Array.from(root.querySelectorAll<HTMLElement>('[data-lane-track]'))) {
      if (lane.dataset.laneKind !== track.kind || lane.dataset.laneLocked === 'true') continue
      const rect = lane.getBoundingClientRect()
      const trackId = lane.dataset.laneTrack
      if (!trackId) continue
      targets.push({ trackId, top: rect.top, bottom: rect.bottom, offsetY: rect.top - originTop })
    }
    return targets
  }

  function beginGesture(event: ReactPointerEvent<HTMLElement>, kind: GestureKind) {
    if (!interactive || event.button !== 0 || editingText !== null) return
    event.preventDefault()
    event.stopPropagation()
    // Pointer capture is absent in non-browser test environments; the gesture
    // still works there, it just loses the off-element tracking guarantee.
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    gestureRef.current = {
      kind,
      pointerId: event.pointerId,
      originClientX: event.clientX,
      origin: { startFrame: clip.startFrame, durationFrames: clip.durationFrames, sourceInFrame: clip.sourceInFrame },
      laneTargets: kind === 'move' ? collectLaneTargets() : [],
      originTrackId: clip.trackId,
    }
    document.body.style.cursor = kind === 'move' ? 'grabbing' : 'ew-resize'
    document.body.style.userSelect = 'none'
  }

  function applyPreview(next: GesturePreview) {
    previewRef.current = next
    setPreview(next)
  }

  function updateGesture(event: ReactPointerEvent<HTMLElement>) {
    const gesture = gestureRef.current
    if (!gesture || event.pointerId !== gesture.pointerId) return
    const deltaFrames = framesFromPixelDelta(event.clientX - gesture.originClientX, zoom)
    const moved = previewRef.current?.moved || Math.abs(event.clientX - gesture.originClientX) > 3

    if (gesture.kind === 'move') {
      const candidate = moveDragStartFrame({
        originStartFrame: gesture.origin.startFrame,
        durationFrames: gesture.origin.durationFrames,
        deltaFrames,
        sequenceDurationFrames: props.sequenceDurationFrames,
      })
      const snapped = props.snapMove({ startFrame: candidate, durationFrames: gesture.origin.durationFrames, clipId: clip.id })
      const startFrame = moveDragStartFrame({
        originStartFrame: snapped.startFrame,
        durationFrames: gesture.origin.durationFrames,
        deltaFrames: 0,
        sequenceDurationFrames: props.sequenceDurationFrames,
      })
      // A clamp that displaced the snapped frame voids the snap indicator.
      props.onSnapPointChange(startFrame === snapped.startFrame ? snapped.point : null)
      const lane = gesture.laneTargets.find((target) => event.clientY >= target.top && event.clientY < target.bottom)
      applyPreview({
        startFrame,
        durationFrames: gesture.origin.durationFrames,
        sourceInFrame: gesture.origin.sourceInFrame,
        trackId: lane?.trackId ?? gesture.originTrackId,
        translateY: lane?.offsetY ?? 0,
        moved,
      })
      return
    }

    if (gesture.kind === 'trim-start') {
      const raw = trimStartDrag({
        originStartFrame: gesture.origin.startFrame,
        originDurationFrames: gesture.origin.durationFrames,
        originSourceInFrame: gesture.origin.sourceInFrame,
        deltaFrames,
      })
      const snapped = props.snapEdge({ frame: raw.startFrame, clipId: clip.id })
      const clamped = trimStartDrag({
        originStartFrame: gesture.origin.startFrame,
        originDurationFrames: gesture.origin.durationFrames,
        originSourceInFrame: gesture.origin.sourceInFrame,
        deltaFrames: snapped.frame - gesture.origin.startFrame,
      })
      props.onSnapPointChange(clamped.startFrame === snapped.frame ? snapped.point : null)
      applyPreview({ ...clamped, trackId: gesture.originTrackId, translateY: 0, moved })
      return
    }

    const rawEnd = gesture.origin.startFrame + trimEndDrag({
      originStartFrame: gesture.origin.startFrame,
      originDurationFrames: gesture.origin.durationFrames,
      sourceInFrame: gesture.origin.sourceInFrame,
      deltaFrames,
      sequenceDurationFrames: props.sequenceDurationFrames,
      sourceDurationFrames: sourceDurationFrames(clip, fps),
    }).durationFrames
    const snapped = props.snapEdge({ frame: rawEnd, clipId: clip.id })
    const clamped = trimEndDrag({
      originStartFrame: gesture.origin.startFrame,
      originDurationFrames: gesture.origin.durationFrames,
      sourceInFrame: gesture.origin.sourceInFrame,
      deltaFrames: snapped.frame - (gesture.origin.startFrame + gesture.origin.durationFrames),
      sequenceDurationFrames: props.sequenceDurationFrames,
      sourceDurationFrames: sourceDurationFrames(clip, fps),
    })
    props.onSnapPointChange(gesture.origin.startFrame + clamped.durationFrames === snapped.frame ? snapped.point : null)
    applyPreview({
      startFrame: gesture.origin.startFrame,
      durationFrames: clamped.durationFrames,
      sourceInFrame: gesture.origin.sourceInFrame,
      trackId: gesture.originTrackId,
      translateY: 0,
      moved,
    })
  }

  function endGestureCleanup() {
    gestureRef.current = null
    previewRef.current = null
    setPreview(null)
    props.onSnapPointChange(null)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  function finishGesture(event: ReactPointerEvent<HTMLElement>) {
    const gesture = gestureRef.current
    if (!gesture || event.pointerId !== gesture.pointerId) return
    const finalPreview = previewRef.current
    const kind = gesture.kind
    const origin = gesture.origin
    const originTrackId = gesture.originTrackId
    endGestureCleanup()

    if (!finalPreview || !finalPreview.moved) {
      props.onSelect(clip.id, event.shiftKey)
      return
    }
    if (kind === 'move') {
      if (finalPreview.startFrame === origin.startFrame && finalPreview.trackId === originTrackId) return
      props.onCommitMove({ clipId: clip.id, startFrame: finalPreview.startFrame, trackId: finalPreview.trackId })
      return
    }
    if (finalPreview.startFrame === origin.startFrame && finalPreview.durationFrames === origin.durationFrames) return
    props.onCommitTrim({
      clipId: clip.id,
      startFrame: finalPreview.startFrame,
      durationFrames: finalPreview.durationFrames,
      sourceInFrame: finalPreview.sourceInFrame,
    })
  }

  // Escape abandons the gesture: pre-drag state restores, nothing emits.
  useEffect(() => {
    if (!preview) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      endGestureCleanup()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // endGestureCleanup is stable in behavior; preview presence gates the listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview !== null])

  // -------------------------------------------------------------------------
  // Media previews (poster frame / waveform)
  // -------------------------------------------------------------------------

  const mediaUrl = clip.media?.url
  const mediaKind = clip.media?.kind
  const isVisualMedia = mediaKind === 'video' || mediaKind === 'image'
  const isAudioMedia = mediaKind === 'audio'

  useEffect(() => {
    const canvas = posterRef.current
    if (!canvas || !mediaUrl || !isVisualMedia) return
    const ctx = canvas.getContext('2d')
    // Canvas 2D is unavailable in non-browser test environments; the chip
    // still lays out, only the poster paint is skipped.
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const cssWidth = canvas.clientWidth || 40
    const cssHeight = canvas.clientHeight || 40
    canvas.width = Math.round(cssWidth * dpr)
    canvas.height = Math.round(cssHeight * dpr)
    ctx.scale(dpr, dpr)
    let cancelled = false
    frameProvider
      .drawFrame(mediaUrl, clip.sourceInFrame / fps, ctx, { x: 0, y: 0, width: cssWidth, height: cssHeight })
      .catch(() => {
        // A failed poster leaves the chip's base tone; the same failure
        // surfaces loudly in the preview canvas where it blocks real work.
        if (!cancelled) canvas.dataset.posterError = 'true'
      })
    return () => {
      cancelled = true
    }
  }, [mediaUrl, isVisualMedia, clip.sourceInFrame, fps, frameProvider])

  useEffect(() => {
    const canvas = waveformRef.current
    if (!canvas || !mediaUrl || !isAudioMedia) return
    let pending = waveformCache.get(clip.id)
    if (!pending) {
      pending = loadWaveform(mediaUrl, WAVEFORM_BUCKETS)
      pending.catch(() => waveformCache.delete(clip.id))
      waveformCache.set(clip.id, pending)
    }
    let cancelled = false
    pending
      .then((data) => {
        if (cancelled) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        const dpr = window.devicePixelRatio || 1
        const cssWidth = canvas.clientWidth || 1
        const cssHeight = canvas.clientHeight || 1
        canvas.width = Math.round(cssWidth * dpr)
        canvas.height = Math.round(cssHeight * dpr)
        ctx.scale(dpr, dpr)
        // Paint only the source window this clip plays.
        const bucketsPerSecond = data.peaks.length / data.durationSeconds
        const fromBucket = Math.floor((shown.sourceInFrame / fps) * bucketsPerSecond)
        const toBucket = Math.ceil(((shown.sourceInFrame + shown.durationFrames) / fps) * bucketsPerSecond)
        const peaks = data.peaks.subarray(Math.max(0, fromBucket), Math.min(data.peaks.length, Math.max(fromBucket + 1, toBucket)))
        if (peaks.length === 0) return
        drawWaveform(
          ctx,
          { peaks, samplesPerBucket: data.samplesPerBucket, durationSeconds: data.durationSeconds },
          { x: 0, y: 0, width: cssWidth, height: cssHeight },
          'rgba(52, 211, 153, 0.75)',
        )
      })
      .catch(() => {
        if (!cancelled) canvas.dataset.waveformError = 'true'
      })
    return () => {
      cancelled = true
    }
  }, [mediaUrl, isAudioMedia, clip.id, fps, shown.sourceInFrame, shown.durationFrames, geometry.width])

  // -------------------------------------------------------------------------
  // Caption text editing
  // -------------------------------------------------------------------------

  function commitText() {
    if (editingText === null) return
    const next = editingText.trim()
    setEditingText(null)
    if (next.length === 0 || next === clip.text) return
    props.onCommitText({ clipId: clip.id, text: next })
  }

  const isCaption = track.kind === 'caption'
  const dragging = preview !== null

  // Keyboard parity with the pointer gestures: the chip is a roving-tabindex
  // button — Enter/Space selects (Shift for additive, mirroring shift-click),
  // Delete/Backspace removes it through the editor's locked-track guard, and
  // Arrow keys walk focus across the chip set. Frame stepping and clip nudging
  // are the editor's keydown (they need the playhead clock + command stack).
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (editingText !== null) return
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault()
      event.stopPropagation()
      props.onSelect(clip.id, event.shiftKey)
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (!interactive) return
      event.preventDefault()
      event.stopPropagation()
      props.onRequestDelete(clip.id)
      return
    }
    // Plain Arrow walks focus across the chip set (roving tabindex). Alt+Arrow
    // is reserved for clip nudge and falls through to the editor's keydown.
    if (event.altKey) return
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      props.onFocusStep(clip.id, -1)
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      props.onFocusStep(clip.id, 1)
    }
  }

  return (
    <div
      ref={rootRef}
      data-clip-id={clip.id}
      role="button"
      aria-pressed={selected}
      aria-label={clip.label}
      tabIndex={tabbable ? 0 : -1}
      onKeyDown={handleKeyDown}
      title={clip.label}
      className={`group absolute bottom-1 top-1 overflow-hidden rounded border text-left select-none outline-none ${KIND_TONES[track.kind]} ${
        selected ? 'ring-2 ring-[var(--brand-primary)]' : 'hover:ring-1 hover:ring-[var(--text-muted)]'
      } focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg-input)] ${clip.disabled ? 'opacity-40' : ''} ${dragging ? 'z-30 shadow-lg shadow-black/30' : ''} ${
        interactive ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
      }`}
      style={{
        left: `${geometry.left}px`,
        width: `${geometry.width}px`,
        transform: shown.translateY !== 0 ? `translateY(${shown.translateY}px)` : undefined,
        // own the touch gesture so move/trim drags don't trigger lane scroll
        touchAction: 'none',
      }}
      onPointerDown={(event) => beginGesture(event, 'move')}
      onPointerMove={updateGesture}
      onPointerUp={finishGesture}
      onPointerCancel={endGestureCleanup}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => {
        event.stopPropagation()
        if (isCaption && interactive && typeof clip.text === 'string') setEditingText(clip.text)
      }}
    >
      {isAudioMedia ? <canvas ref={waveformRef} className="absolute inset-0 h-full w-full" /> : null}

      <div className="relative flex h-full min-w-0 items-stretch gap-1.5 px-1.5 py-1">
        {isVisualMedia ? (
          <canvas ref={posterRef} className="h-full w-10 shrink-0 rounded-sm bg-black/40 object-cover" />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium leading-4 text-[var(--text-primary)]">
            {isCaption && typeof clip.text === 'string' ? clip.text : clip.label}
          </div>
          <span className="mt-0.5 inline-block rounded bg-black/30 px-1 font-mono text-[9px] leading-3 text-[var(--text-secondary)]">
            {formatTimecode(shown.durationFrames, fps)}
          </span>
        </div>
      </div>

      {editingText !== null ? (
        <input
          autoFocus
          value={editingText}
          onChange={(event) => setEditingText(event.target.value)}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitText()
            if (event.key === 'Escape') setEditingText(null)
            event.stopPropagation()
          }}
          onBlur={commitText}
          className="agent-app-edit-selection absolute inset-0 z-10 w-full bg-black/80 px-1.5 text-[11px] text-[var(--text-primary)] outline-none ring-1 ring-[var(--brand-primary)]"
          aria-label="Caption text"
        />
      ) : null}

      {interactive ? (
        <>
          <span
            data-trim-handle="start"
            className="absolute bottom-0 left-0 top-0 z-10 w-1.5 cursor-ew-resize bg-transparent opacity-0 transition group-hover:opacity-100 group-hover:bg-[var(--brand-primary)]/60"
            onPointerDown={(event) => beginGesture(event, 'trim-start')}
            onPointerMove={updateGesture}
            onPointerUp={finishGesture}
            onPointerCancel={endGestureCleanup}
            aria-hidden
          />
          <span
            data-trim-handle="end"
            className="absolute bottom-0 right-0 top-0 z-10 w-1.5 cursor-ew-resize bg-transparent opacity-0 transition group-hover:opacity-100 group-hover:bg-[var(--brand-primary)]/60"
            onPointerDown={(event) => beginGesture(event, 'trim-end')}
            onPointerMove={updateGesture}
            onPointerUp={finishGesture}
            onPointerCancel={endGestureCleanup}
            aria-hidden
          />
        </>
      ) : null}
    </div>
  )
}
