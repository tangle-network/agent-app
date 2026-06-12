/**
 * The timeline editor surface: program monitor, transport row, and the
 * scrollable track area, composed over the engine (command stack, zoom math,
 * snapping, playback clock) and media (frame provider, waveforms) layers.
 *
 * State ownership:
 * - The COMMAND STACK owns the timeline. Every edit is a `TimelineCommand`
 *   executed optimistically, then persisted via `onApplyOperations`; a
 *   rejected persist rolls the command back locally WITHOUT emitting its
 *   inverse (the server never saw it). A user-initiated undo/redo DOES emit
 *   (the server applied the original), so the editor mirrors the executed
 *   commands to know which operations an undo corresponds to — the engine
 *   stack exposes no command identity from `undo()`.
 * - Clip-creating commands mint optimistic `local-…` ids. When
 *   `onApplyOperations` resolves with `SequenceApplyResult[]`, the editor
 *   records local→server aliases that every command resolves through at
 *   execute/undo/emission time, so undoing a committed place/split/caption
 *   works after a server refresh. Hosts resolving void skip reconciliation;
 *   undo of creates then fails loud (error bar) once a refresh replaced the
 *   local ids.
 *
 * Captions require an unlocked caption track: the editor creates clips, never
 * tracks. Products seed a caption track at sequence creation (or let the
 * agent's create_track tool add one); the caption button errors otherwise.
 * - The PLAYBACK CLOCK owns the playhead. Volatile view state (selection,
 *   zoom, snap toggle) lives in React state; the contract's
 *   `EditorTimelineState` view fields are initials, not a live channel.
 *
 * Compositing/stacking rule: `sortOrder` is paint order — later tracks paint
 * over earlier ones in the preview; rows render top→bottom in the same order.
 *
 * Asset drops: lanes accept `application/x-sequence-media` payloads
 * (JSON `{ url, kind, label?, durationSeconds?, generationId?, assetId? }`),
 * which is how a host's `renderAssetShelf` content places media — video/image
 * onto video tracks, audio onto audio tracks.
 *
 * Keyboard: space play/pause · delete/backspace removes the selection (one
 * undo step) · mod+z undo · shift+mod+z / mod+y redo · escape cancels an
 * in-flight drag (handled by the chips).
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import {
  chooseCaptionPlacement,
  formatTimecode,
  secondsToFrames,
  trackIntervals,
} from '../../sequences/model'
import type { SequenceApplyResult } from '../../sequences/apply'
import type { SequenceClip, SequenceMediaKind } from '../../sequences/model'
import type { SequenceOperation } from '../../sequences/operations'
import type { SnapPoint, TimelineCommand, TimelineEditorProps, VideoFrameProvider } from '../contracts'
import { createCommandStack } from '../engine/command-stack'
import {
  addCaptionCommand,
  deleteClipCommand,
  moveClipCommand,
  placeClipCommand,
  setClipTextCommand,
  splitClipCommand,
  trimClipCommand,
} from '../engine/commands'
import { createPlaybackClock } from '../engine/playback'
import { applySnap, collectSnapPoints } from '../engine/snap'
import type { TimelineSnapPoint } from '../engine/snap'
import { createZoomMath } from '../engine/zoom'
import { createVideoElementFrameProvider } from '../media/frame-provider'
import { compositeCommand } from './composite-command'
import { chooseMoveSnap } from './interaction-math'
import { PreviewCanvas } from './PreviewCanvas'
import { SnapIndicatorLine } from './SnapIndicatorLine'
import type { ClipMoveCommit, ClipTrimCommit } from './TimelineClipChip'
import { TimelinePlayhead } from './TimelinePlayhead'
import { TimelineRuler } from './TimelineRuler'
import { TimelineTrackRow } from './TimelineTrackRow'
import { ZoomControl } from './ZoomControl'
import {
  CaptionPlusGlyph,
  MagnetGlyph,
  PauseGlyph,
  PlayGlyph,
  RedoGlyph,
  ScissorsGlyph,
  UndoGlyph,
} from './glyphs'

export const SEQUENCE_MEDIA_DRAG_TYPE = 'application/x-sequence-media'

/** Matches the engine's COMMAND_HISTORY_LIMIT so the operation mirror and the
 *  stack's history can never disagree about what an undo refers to. */
const HISTORY_MIRROR_LIMIT = 200

const MIN_ZOOM = 0.005
const MAX_ZOOM = 24
/** Tailwind w-36 on the track header column. */
const TRACK_HEADER_PX = 144

const TRANSPORT_BUTTON =
  'flex h-7 w-7 items-center justify-center rounded border border-[var(--border-default)] text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] disabled:cursor-default disabled:opacity-40 disabled:hover:text-[var(--text-secondary)]'

function mintClipId(): string {
  const uuid = globalThis.crypto && 'randomUUID' in globalThis.crypto ? globalThis.crypto.randomUUID() : null
  return `local-${uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('input, textarea, select, button, [contenteditable="true"]') !== null
}

interface MediaDragPayload {
  url: string
  kind: SequenceMediaKind
  label?: string
  durationSeconds?: number
  generationId?: string
  assetId?: string
}

function parseMediaDragPayload(raw: string): MediaDragPayload {
  const parsed = JSON.parse(raw) as Partial<MediaDragPayload>
  if (typeof parsed.url !== 'string' || parsed.url.length === 0) {
    throw new Error(`${SEQUENCE_MEDIA_DRAG_TYPE} payload requires a non-empty url`)
  }
  if (parsed.kind !== 'video' && parsed.kind !== 'image' && parsed.kind !== 'audio') {
    throw new Error(`${SEQUENCE_MEDIA_DRAG_TYPE} payload kind must be video | image | audio, got ${String(parsed.kind)}`)
  }
  return parsed as MediaDragPayload
}

export function TimelineEditor(props: TimelineEditorProps) {
  const { canWrite, onApplyOperations } = props
  const fps = props.timeline.sequence.fps
  const durationFrames = props.timeline.sequence.durationFrames

  // --- engine lifecycles ----------------------------------------------------

  const stack = useMemo(() => createCommandStack(props.timeline), [])
  const editorState = useSyncExternalStore(stack.subscribe, stack.getState, stack.getState)
  const timeline = editorState.timeline

  const appliedTimelineRef = useRef(props.timeline)
  useEffect(() => {
    if (appliedTimelineRef.current === props.timeline) return
    appliedTimelineRef.current = props.timeline
    stack.reset(props.timeline)
  }, [props.timeline, stack])

  const clock = useMemo(
    () => createPlaybackClock({ fps, durationFrames: timeline.sequence.durationFrames }),
    [fps, timeline.sequence.durationFrames],
  )
  useEffect(() => () => clock.dispose(), [clock])

  const [playheadFrame, setPlayheadFrame] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const onPlayheadChangeRef = useRef(props.onPlayheadChange)
  onPlayheadChangeRef.current = props.onPlayheadChange
  useEffect(() => {
    // A recreated clock (duration change) resumes from the prior playhead.
    clock.seek(Math.min(playheadFrame, timeline.sequence.durationFrames - 1))
    return clock.subscribe((frame) => {
      setPlayheadFrame(frame)
      setIsPlaying(clock.isPlaying())
      onPlayheadChangeRef.current?.(frame)
    })
    // playheadFrame is intentionally read once per clock identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock])

  const ownedProviderRef = useRef<VideoFrameProvider | null>(null)
  const frameProvider = useMemo(() => {
    if (props.frameProvider) return props.frameProvider
    if (!ownedProviderRef.current) ownedProviderRef.current = createVideoElementFrameProvider()
    return ownedProviderRef.current
  }, [props.frameProvider])
  useEffect(
    () => () => {
      ownedProviderRef.current?.dispose()
      ownedProviderRef.current = null
    },
    [],
  )

  // --- view state -------------------------------------------------------------

  const zoomMath = useMemo(() => createZoomMath({ minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM }), [])
  const [zoom, setZoom] = useState(1)
  const trackViewportRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    // Initial zoom fits the whole sequence into the visible track viewport.
    const viewport = trackViewportRef.current
    if (!viewport) return
    const laneWidth = viewport.clientWidth - TRACK_HEADER_PX
    if (laneWidth <= 0) return
    setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, laneWidth / durationFrames)))
    // Fit once on mount; afterwards zoom belongs to the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [snapEnabled, setSnapEnabled] = useState(true)
  const [activeSnapPoint, setActiveSnapPoint] = useState<SnapPoint | null>(null)
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([])
  const [commitError, setCommitError] = useState<string | null>(null)

  const selectedClips = useMemo(
    () => timeline.clips.filter((clip) => selectedClipIds.includes(clip.id)),
    [timeline, selectedClipIds],
  )
  const onSelectionChangeRef = useRef(props.onSelectionChange)
  onSelectionChangeRef.current = props.onSelectionChange
  useEffect(() => {
    onSelectionChangeRef.current?.(selectedClips)
  }, [selectedClips])

  const sortedTracks = useMemo(() => [...timeline.tracks].sort((a, b) => a.sortOrder - b.sortOrder), [timeline.tracks])
  const clipsByTrack = useMemo(() => {
    const byTrack = new Map<string, SequenceClip[]>()
    for (const clip of timeline.clips) {
      const bucket = byTrack.get(clip.trackId)
      if (bucket) bucket.push(clip)
      else byTrack.set(clip.trackId, [clip])
    }
    return byTrack
  }, [timeline.clips])

  // --- command commit + history mirror ---------------------------------------

  interface HistoryEntry {
    command: TimelineCommand
    /** Optimistic ids this command's clip-creating operations minted, in
     *  operation order — the pairing key for id reconciliation. */
    createdLocalIds: string[]
  }

  const historyRef = useRef<{ done: HistoryEntry[]; undone: HistoryEntry[] }>({ done: [], undone: [] })

  /** Local→server clip-id aliases, fed by `onApplyOperations` results and
   *  consulted live by every command (see engine/commands resolveClipId). */
  const clipIdAliasesRef = useRef(new Map<string, string>())

  function resolveClipId(clipId: string): string {
    return clipIdAliasesRef.current.get(clipId) ?? clipId
  }

  /** Pair each clip-creating operation with its apply result and record the
   *  local→server alias. Results are index-aligned with operations (the
   *  `applySequenceOperations` contract); a host returning a mismatched array
   *  is a wiring bug surfaced loud, not silently skipped. */
  function reconcileCreatedClipIds(
    operations: SequenceOperation[],
    createdLocalIds: string[],
    results: SequenceApplyResult[] | void,
  ) {
    if (createdLocalIds.length === 0 || !Array.isArray(results)) return
    if (results.length !== operations.length) {
      setCommitError(
        `onApplyOperations returned ${results.length} results for ${operations.length} operations — clip-id reconciliation skipped`,
      )
      return
    }
    let cursor = 0
    operations.forEach((operation, index) => {
      if (operation.type !== 'place_clip' && operation.type !== 'add_caption' && operation.type !== 'split_clip') return
      const localId = createdLocalIds[cursor]
      cursor += 1
      const result = results[index]
      if (localId !== undefined && result !== undefined && result.kind === 'clip') {
        clipIdAliasesRef.current.set(localId, result.clip.id)
      }
    })
  }

  function commitCommand(command: TimelineCommand, createdLocalIds: string[] = []) {
    if (!canWrite) return
    try {
      stack.execute(command)
    } catch (error) {
      setCommitError(error instanceof Error ? error.message : String(error))
      return
    }
    const history = historyRef.current
    const entry: HistoryEntry = { command, createdLocalIds }
    history.done.push(entry)
    if (history.done.length > HISTORY_MIRROR_LIMIT) history.done.splice(0, history.done.length - HISTORY_MIRROR_LIMIT)
    history.undone = []
    setCommitError(null)
    const operations = command.operations()
    void onApplyOperations(operations)
      .then((results) => reconcileCreatedClipIds(operations, createdLocalIds, results))
      .catch((error: unknown) => {
        // Roll back ONLY when this command is still the newest local edit; if
        // the user already undid or stacked more edits, local rollback would
        // corrupt history — surface the error and let the next server refresh
        // (stack.reset) reconcile.
        const mirror = historyRef.current
        if (mirror.done[mirror.done.length - 1] === entry && stack.canUndo()) {
          stack.undo()
          mirror.done.pop()
        }
        setCommitError(error instanceof Error ? error.message : String(error))
      })
  }

  function undoLast() {
    const history = historyRef.current
    const entry = history.done[history.done.length - 1]
    if (!entry || !stack.canUndo()) return
    try {
      stack.undo()
    } catch (error) {
      // A reset() removed the command's target clip; the stack kept the entry
      // (it may succeed after the next refresh), so the mirror stays too.
      setCommitError(`Undo failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    history.done.pop()
    history.undone.push(entry)
    void onApplyOperations(entry.command.inverseOperations()).catch((error: unknown) => {
      setCommitError(error instanceof Error ? error.message : String(error))
    })
  }

  function redoLast() {
    const history = historyRef.current
    const entry = history.undone[history.undone.length - 1]
    if (!entry || !stack.canRedo()) return
    try {
      stack.redo()
    } catch (error) {
      setCommitError(`Redo failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    history.undone.pop()
    history.done.push(entry)
    const operations = entry.command.operations()
    // A redo of a clip-creating command mints fresh server ids — re-pair them
    // so a later undo deletes the recreated clips, not the stale ones.
    void onApplyOperations(operations)
      .then((results) => reconcileCreatedClipIds(operations, entry.createdLocalIds, results))
      .catch((error: unknown) => {
        setCommitError(error instanceof Error ? error.message : String(error))
      })
  }

  // --- edit handlers ----------------------------------------------------------

  function handleCommitMove(input: ClipMoveCommit) {
    const current = stack.getState().timeline
    const clip = current.clips.find((candidate) => candidate.id === input.clipId)
    if (!clip) return
    commitCommand(
      moveClipCommand({
        timeline: current,
        clipId: input.clipId,
        startFrame: input.startFrame,
        ...(input.trackId !== clip.trackId ? { trackId: input.trackId } : {}),
        resolveClipId,
      }),
    )
  }

  function handleCommitTrim(input: ClipTrimCommit) {
    commitCommand(
      trimClipCommand({
        timeline: stack.getState().timeline,
        clipId: input.clipId,
        startFrame: input.startFrame,
        durationFrames: input.durationFrames,
        sourceInFrame: input.sourceInFrame,
        resolveClipId,
      }),
    )
  }

  function handleCommitText(input: { clipId: string; text: string }) {
    commitCommand(
      setClipTextCommand({ timeline: stack.getState().timeline, clipId: input.clipId, text: input.text, resolveClipId }),
    )
  }

  function deleteSelection() {
    const current = stack.getState().timeline
    const lockedTrackIds = new Set(current.tracks.filter((track) => track.locked).map((track) => track.id))
    const targets = selectedClips.filter((clip) => !lockedTrackIds.has(clip.trackId))
    if (targets.length === 0) return
    const commands = targets.map((clip) => deleteClipCommand({ timeline: current, clipId: clip.id, resolveClipId }))
    commitCommand(commands.length === 1 ? (commands[0] as TimelineCommand) : compositeCommand(`Delete ${commands.length} clips`, commands))
    setSelectedClipIds([])
  }

  const splittableClip =
    selectedClips.length === 1 &&
    selectedClips[0] &&
    playheadFrame > selectedClips[0].startFrame &&
    playheadFrame < selectedClips[0].startFrame + selectedClips[0].durationFrames
      ? selectedClips[0]
      : null

  function splitAtPlayhead() {
    if (!splittableClip) return
    const newClipId = mintClipId()
    commitCommand(
      splitClipCommand({
        timeline: stack.getState().timeline,
        clipId: splittableClip.id,
        atFrame: playheadFrame,
        newClipId,
        resolveClipId,
      }),
      [newClipId],
    )
  }

  function addCaptionAtPlayhead() {
    const current = stack.getState().timeline
    const captionTrack = [...current.tracks]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .find((track) => track.kind === 'caption' && !track.locked)
    if (!captionTrack) {
      setCommitError('No unlocked caption track in this sequence — add one before inserting captions.')
      return
    }
    // Throws when the caption track has no free gap left near the playhead.
    let placement: { startFrame: number; durationFrames: number }
    try {
      placement = chooseCaptionPlacement({
        playheadFrame,
        fps,
        sequenceDurationFrames: current.sequence.durationFrames,
        occupiedIntervals: trackIntervals(current, captionTrack.id),
      })
    } catch (error) {
      setCommitError(error instanceof Error ? error.message : String(error))
      return
    }
    const clipId = mintClipId()
    commitCommand(
      addCaptionCommand({
        timeline: current,
        clipId,
        trackId: captionTrack.id,
        text: 'New caption',
        startFrame: placement.startFrame,
        durationFrames: placement.durationFrames,
        resolveClipId,
      }),
      [clipId],
    )
  }

  function selectClip(clipId: string, additive: boolean) {
    setSelectedClipIds((current) => {
      if (!additive) return [clipId]
      return current.includes(clipId) ? current.filter((id) => id !== clipId) : [...current, clipId]
    })
  }

  // --- snapping ---------------------------------------------------------------

  function snapMove(candidate: { startFrame: number; durationFrames: number; clipId: string }) {
    if (!snapEnabled) return { startFrame: candidate.startFrame, point: null }
    const points = collectSnapPoints(timeline, playheadFrame)
    const exclude = (point: SnapPoint) => (point as TimelineSnapPoint).clipId === candidate.clipId
    return chooseMoveSnap({
      candidateStartFrame: candidate.startFrame,
      durationFrames: candidate.durationFrames,
      startSnap: applySnap(candidate.startFrame, points, { zoom, exclude }),
      endSnap: applySnap(candidate.startFrame + candidate.durationFrames, points, { zoom, exclude }),
    })
  }

  function snapEdge(candidate: { frame: number; clipId: string }) {
    if (!snapEnabled) return { frame: candidate.frame, point: null }
    const points = collectSnapPoints(timeline, playheadFrame)
    const result = applySnap(candidate.frame, points, {
      zoom,
      exclude: (point: SnapPoint) => (point as TimelineSnapPoint).clipId === candidate.clipId,
    })
    return { frame: result.frame, point: result.point }
  }

  // --- transport --------------------------------------------------------------

  function togglePlayback() {
    if (clock.isPlaying()) clock.pause()
    else clock.play()
    setIsPlaying(clock.isPlaying())
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.code === 'Space' && !isTypingTarget(event.target)) {
        event.preventDefault()
        togglePlayback()
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && !isTypingTarget(event.target)) {
        if (!canWrite) return
        event.preventDefault()
        deleteSelection()
        return
      }
      const mod = event.metaKey || event.ctrlKey
      if (!mod || isTypingTarget(event.target)) return
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redoLast()
        else undoLast()
      } else if (event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redoLast()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  // --- asset drops ------------------------------------------------------------

  function handleTrackAreaDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!canWrite || !event.dataTransfer.types.includes(SEQUENCE_MEDIA_DRAG_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  function handleTrackAreaDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (!canWrite || !event.dataTransfer.types.includes(SEQUENCE_MEDIA_DRAG_TYPE)) return
    event.preventDefault()
    const lane = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-lane-track]') : null
    if (!lane || !lane.dataset.laneTrack) {
      setCommitError('Drop media on a track lane to place it.')
      return
    }
    let payload: MediaDragPayload
    try {
      payload = parseMediaDragPayload(event.dataTransfer.getData(SEQUENCE_MEDIA_DRAG_TYPE))
    } catch (error) {
      setCommitError(error instanceof Error ? error.message : String(error))
      return
    }
    const laneKind = lane.dataset.laneKind
    const accepts = laneKind === 'video' ? payload.kind === 'video' || payload.kind === 'image' : laneKind === 'audio' ? payload.kind === 'audio' : false
    if (!accepts || lane.dataset.laneLocked === 'true') {
      setCommitError(`A ${laneKind ?? 'unknown'} track cannot take ${payload.kind} media${lane.dataset.laneLocked === 'true' ? ' (track is locked)' : ''}.`)
      return
    }
    const current = stack.getState().timeline
    const rect = lane.getBoundingClientRect()
    const dropFrame = Math.max(0, Math.round((event.clientX - rect.left) / zoom))
    const naturalDuration = payload.durationSeconds !== undefined
      ? secondsToFrames(payload.durationSeconds, fps)
      : payload.kind === 'image'
        ? fps * 3
        : fps * 5
    const startFrame = Math.min(dropFrame, current.sequence.durationFrames - 1)
    const placedDuration = Math.max(1, Math.min(naturalDuration, current.sequence.durationFrames - startFrame))
    const clipId = mintClipId()
    commitCommand(
      placeClipCommand({
        timeline: current,
        clipId,
        trackId: lane.dataset.laneTrack,
        label: payload.label ?? payload.url.split('/').pop() ?? payload.url,
        startFrame,
        durationFrames: placedDuration,
        media: { url: payload.url, kind: payload.kind },
        ...(payload.generationId !== undefined ? { generationId: payload.generationId } : {}),
        ...(payload.assetId !== undefined ? { assetId: payload.assetId } : {}),
        resolveClipId,
      }),
      [clipId],
    )
  }

  // --- render -------------------------------------------------------------------

  const timelineWidth = timeline.sequence.durationFrames * zoom

  return (
    <div className={`flex h-full min-h-0 flex-col bg-[var(--bg-input)] text-[var(--text-primary)] ${props.className ?? ''}`}>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <PreviewCanvas timeline={timeline} clock={clock} frameProvider={frameProvider} />

          <div className="flex h-10 shrink-0 items-center gap-2 border-y border-[var(--border-default)] px-2">
            <button
              type="button"
              aria-label={isPlaying ? 'Pause' : 'Play'}
              onClick={togglePlayback}
              className={TRANSPORT_BUTTON}
            >
              {isPlaying ? <PauseGlyph className="h-3.5 w-3.5" /> : <PlayGlyph className="h-3.5 w-3.5" />}
            </button>
            <span className="font-mono text-xs tabular-nums text-[var(--text-secondary)]">
              {formatTimecode(playheadFrame, fps)}
              <span className="text-[var(--text-muted)]"> / {formatTimecode(timeline.sequence.durationFrames, fps)}</span>
            </span>

            <div className="mx-1 h-4 w-px bg-[var(--border-default)]" />

            <button type="button" aria-label="Undo" disabled={!stack.canUndo() || !canWrite} onClick={undoLast} className={TRANSPORT_BUTTON}>
              <UndoGlyph className="h-3.5 w-3.5" />
            </button>
            <button type="button" aria-label="Redo" disabled={!stack.canRedo() || !canWrite} onClick={redoLast} className={TRANSPORT_BUTTON}>
              <RedoGlyph className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label="Toggle snapping"
              aria-pressed={snapEnabled}
              onClick={() => setSnapEnabled((current) => !current)}
              className={`${TRANSPORT_BUTTON} ${snapEnabled ? 'border-[var(--brand-primary)] text-[var(--brand-primary)] hover:text-[var(--brand-primary)]' : ''}`}
            >
              <MagnetGlyph className="h-3.5 w-3.5" />
            </button>

            {canWrite ? (
              <>
                <button type="button" aria-label="Split clip at playhead" disabled={!splittableClip} onClick={splitAtPlayhead} className={TRANSPORT_BUTTON}>
                  <ScissorsGlyph className="h-3.5 w-3.5" />
                </button>
                <button type="button" aria-label="Add caption at playhead" onClick={addCaptionAtPlayhead} className={TRANSPORT_BUTTON}>
                  <CaptionPlusGlyph className="h-3.5 w-3.5" />
                </button>
              </>
            ) : null}

            <div className="flex-1" />
            <ZoomControl zoomMath={zoomMath} zoom={zoom} onZoomChange={setZoom} />
          </div>

          {commitError ? (
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300" role="alert">
              <span className="min-w-0 truncate">{commitError}</span>
              <button type="button" onClick={() => setCommitError(null)} className="shrink-0 underline-offset-2 hover:underline">
                Dismiss
              </button>
            </div>
          ) : null}

          {props.renderAssetShelf ? (
            <div className="shrink-0 border-b border-[var(--border-default)]">{props.renderAssetShelf()}</div>
          ) : null}

          <div
            ref={trackViewportRef}
            data-timeline-tracks
            className="relative h-60 shrink-0 overflow-auto overscroll-x-contain"
            onDragOver={handleTrackAreaDragOver}
            onDrop={handleTrackAreaDrop}
          >
            <div className="relative" style={{ width: `${TRACK_HEADER_PX + timelineWidth}px`, minWidth: '100%' }}>
              <div className="sticky top-0 z-20 flex">
                <div className="sticky left-0 z-30 w-36 shrink-0 border-b border-r border-[var(--border-default)] bg-[var(--bg-input)]" />
                <TimelineRuler fps={fps} durationFrames={timeline.sequence.durationFrames} zoom={zoom} onScrub={(frame) => clock.seek(frame)} />
              </div>

              <div className="relative">
                {sortedTracks.map((track) => (
                  <TimelineTrackRow
                    key={track.id}
                    track={track}
                    clips={clipsByTrack.get(track.id) ?? []}
                    fps={fps}
                    zoom={zoom}
                    sequenceDurationFrames={timeline.sequence.durationFrames}
                    selectedClipIds={new Set(selectedClipIds)}
                    canWrite={canWrite}
                    frameProvider={frameProvider}
                    snapMove={snapMove}
                    snapEdge={snapEdge}
                    onSnapPointChange={setActiveSnapPoint}
                    onSelectClip={selectClip}
                    onCommitMove={handleCommitMove}
                    onCommitTrim={handleCommitTrim}
                    onCommitText={handleCommitText}
                    onLaneSeek={(frame) => clock.seek(frame)}
                  />
                ))}
                <div className="pointer-events-none absolute inset-y-0" style={{ left: `${TRACK_HEADER_PX}px`, width: `${timelineWidth}px` }}>
                  <TimelinePlayhead frame={playheadFrame} zoom={zoom} />
                  <SnapIndicatorLine point={activeSnapPoint} zoom={zoom} />
                </div>
              </div>
            </div>
          </div>
        </div>

        {props.renderSidePanel ? (
          <aside className="flex w-80 shrink-0 flex-col overflow-hidden border-l border-[var(--border-default)]">
            {props.renderSidePanel({ selectedClips, playheadFrame })}
          </aside>
        ) : null}
      </div>
    </div>
  )
}

export default TimelineEditor
