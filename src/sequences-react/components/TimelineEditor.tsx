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
  clampClipStart,
  formatTimecode,
  secondsToFrames,
  trackIntervals,
} from '../../sequences/model'
import type { SequenceApplyResult } from '../../sequences/apply'
import type { SequenceClip, SequenceMediaKind } from '../../sequences/model'
import type { SequenceOperation } from '../../sequences/operations'
import type { PlaybackClock, SnapPoint, TimelineCommand, TimelineEditorProps, VideoFrameProvider } from '../contracts'
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
  FilmGlyph,
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

  // The playback clock lives in state so render-time consumers (preview canvas,
  // transport, scrub handlers) share the exact instance the driving effect owns.
  // Creation and disposal are co-located inside that effect, keyed on the engine
  // config, so every (re)mount builds a fresh clock. Tying a render-created
  // clock's disposal to an effect cleanup instead reuses the disposed instance
  // under React StrictMode's mount/unmount/remount probe — the remount then
  // seeks a disposed clock ("PlaybackClock is disposed"). The initial state value
  // is a placeholder the effect disposes and replaces on mount; a recreated clock
  // (duration change) resumes from the prior playhead, tracked in a ref.
  const [clock, setClock] = useState<PlaybackClock>(() =>
    createPlaybackClock({ fps, durationFrames: timeline.sequence.durationFrames }),
  )
  const clockRef = useRef(clock)
  const [playheadFrame, setPlayheadFrame] = useState(0)
  const playheadFrameRef = useRef(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const onPlayheadChangeRef = useRef(props.onPlayheadChange)
  onPlayheadChangeRef.current = props.onPlayheadChange

  useEffect(() => {
    const next = createPlaybackClock({ fps, durationFrames: timeline.sequence.durationFrames })
    // Dispose the clock this run replaces — the initial placeholder on the first
    // run, or an already-disposed prior clock on a config change (dispose is
    // idempotent) — so no instance is left undisposed across recreations.
    clockRef.current.dispose()
    clockRef.current = next
    setClock(next)
    next.seek(Math.min(playheadFrameRef.current, timeline.sequence.durationFrames - 1))
    const unsubscribe = next.subscribe((frame) => {
      playheadFrameRef.current = frame
      setPlayheadFrame(frame)
      setIsPlaying(next.isPlaying())
      onPlayheadChangeRef.current?.(frame)
    })
    return () => {
      unsubscribe()
      next.dispose()
    }
  }, [fps, timeline.sequence.durationFrames])

  // The frame provider follows the same effect-owned lifecycle as the playback
  // clock: created and disposed inside the effect so a remount — including React
  // StrictMode's mount/unmount/remount probe — rebuilds it rather than leaving a
  // disposed provider in render. A caller-supplied provider is used as-is and is
  // never disposed here; only one we create is. The initial state value is a
  // placeholder the effect disposes and replaces on mount (or the caller's
  // provider, which the effect leaves untouched).
  const [frameProvider, setFrameProvider] = useState<VideoFrameProvider>(
    () => props.frameProvider ?? createVideoElementFrameProvider(),
  )
  const frameProviderRef = useRef(frameProvider)
  const ownsFrameProviderRef = useRef(!props.frameProvider)
  useEffect(() => {
    const next = props.frameProvider ?? createVideoElementFrameProvider()
    if (ownsFrameProviderRef.current) frameProviderRef.current.dispose()
    ownsFrameProviderRef.current = !props.frameProvider
    frameProviderRef.current = next
    setFrameProvider(next)
    return () => {
      if (!props.frameProvider) next.dispose()
    }
  }, [props.frameProvider])

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
  // Chips render track-by-track (sortOrder), clips in array order within a
  // track — the roving-tabindex walk order and the seed for the lone Tab stop.
  const orderedClipIds = useMemo(() => {
    const ids: string[] = []
    for (const track of sortedTracks) {
      for (const clip of timeline.clips) {
        if (clip.trackId === track.id) ids.push(clip.id)
      }
    }
    return ids
  }, [sortedTracks, timeline.clips])
  const tabbableClipId = useMemo(() => {
    const selected = orderedClipIds.find((id) => selectedClipIds.includes(id))
    return selected ?? orderedClipIds[0] ?? null
  }, [orderedClipIds, selectedClipIds])
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

  function deleteClip(clipId: string) {
    const current = stack.getState().timeline
    const clip = current.clips.find((candidate) => candidate.id === clipId)
    if (!clip) return
    const track = current.tracks.find((candidate) => candidate.id === clip.trackId)
    if (track?.locked) return
    commitCommand(deleteClipCommand({ timeline: current, clipId, resolveClipId }))
    setSelectedClipIds((ids) => ids.filter((id) => id !== clipId))
  }

  function focusStepClip(clipId: string, direction: -1 | 1) {
    const index = orderedClipIds.indexOf(clipId)
    if (index === -1) return
    const nextId = orderedClipIds[index + direction]
    if (nextId === undefined) return
    const root = trackViewportRef.current
    const next = root?.querySelector<HTMLElement>(`[data-clip-id="${CSS.escape(nextId)}"]`)
    next?.focus()
  }

  /** Step the playhead by whole frames, clamped to the sequence. The transport
   *  clock owns the playhead, so this seeks it — frame-accurate, no float drift. */
  function stepPlayhead(deltaFrames: number) {
    const max = stack.getState().timeline.sequence.durationFrames - 1
    const next = Math.max(0, Math.min(max, playheadFrameRef.current + deltaFrames))
    clock.seek(next)
  }

  /** Nudge the single selected clip by whole frames through the same optimistic
   *  move command a pointer drag commits (one undo step per keypress). */
  function nudgeSelectedClip(deltaFrames: number) {
    if (!canWrite) return
    const selectedId = selectedClipIds.length === 1 ? selectedClipIds[0] : undefined
    if (selectedId === undefined) return
    const current = stack.getState().timeline
    const clip = current.clips.find((candidate) => candidate.id === selectedId)
    if (!clip) return
    const track = current.tracks.find((candidate) => candidate.id === clip.trackId)
    if (track?.locked) return
    const startFrame = clampClipStart({
      startFrame: clip.startFrame + deltaFrames,
      durationFrames: clip.durationFrames,
      sequenceDurationFrames: current.sequence.durationFrames,
    })
    if (startFrame === clip.startFrame) return
    commitCommand(moveClipCommand({ timeline: current, clipId: selectedId, startFrame, resolveClipId }))
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
      if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !isTypingTarget(event.target)) {
        const direction = event.key === 'ArrowLeft' ? -1 : 1
        // Alt+Arrow nudges the selected clip by whole frames (canvas-grain
        // "move the thing" modifier), one undo step per press.
        if (event.altKey) {
          event.preventDefault()
          nudgeSelectedClip(direction)
          return
        }
        // A focused chip owns plain Arrow to walk focus across the chip set;
        // the editor only steps the playhead when focus is elsewhere.
        if (event.target instanceof Element && event.target.closest('[data-clip-id]')) return
        event.preventDefault()
        stepPlayhead(direction * (event.shiftKey ? 10 : 1))
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
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.1)] px-3 py-1.5 text-xs text-[var(--text-danger)]" role="alert">
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
            className="relative max-h-60 min-h-[6rem] shrink-0 overflow-auto overscroll-x-contain"
            onDragOver={handleTrackAreaDragOver}
            onDrop={handleTrackAreaDrop}
          >
            <div className="relative" style={{ width: `${TRACK_HEADER_PX + timelineWidth}px`, minWidth: '100%' }}>
              <div className="sticky top-0 z-20 flex">
                <div className="sticky left-0 z-30 w-36 shrink-0 border-b border-r border-[var(--border-default)] bg-[var(--bg-input)]" />
                <TimelineRuler fps={fps} durationFrames={timeline.sequence.durationFrames} zoom={zoom} onScrub={(frame) => clock.seek(frame)} />
              </div>

              <div className="relative">
                {sortedTracks.length === 0 ? (
                  <div
                    data-timeline-empty
                    className="sticky left-0 flex min-h-[6rem] flex-col items-center justify-center gap-1.5 px-6 py-10 text-center"
                    style={{ width: '100%' }}
                  >
                    <FilmGlyph className="h-6 w-6 text-[var(--text-muted)]" />
                    <p className="text-sm font-medium text-[var(--text-secondary)]">This sequence has no tracks yet</p>
                    <p className="max-w-xs text-xs text-[var(--text-muted)]">
                      Add a video, audio, or caption track to start placing clips.
                    </p>
                  </div>
                ) : null}
                {sortedTracks.map((track) => (
                  <TimelineTrackRow
                    key={track.id}
                    track={track}
                    clips={clipsByTrack.get(track.id) ?? []}
                    fps={fps}
                    zoom={zoom}
                    sequenceDurationFrames={timeline.sequence.durationFrames}
                    selectedClipIds={new Set(selectedClipIds)}
                    tabbableClipId={tabbableClipId}
                    canWrite={canWrite}
                    frameProvider={frameProvider}
                    snapMove={snapMove}
                    snapEdge={snapEdge}
                    onSnapPointChange={setActiveSnapPoint}
                    onSelectClip={selectClip}
                    onRequestDeleteClip={deleteClip}
                    onFocusStepClip={focusStepClip}
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
