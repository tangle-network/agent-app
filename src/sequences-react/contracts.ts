/**
 * Seams between the timeline editor's engine, media pipeline, and components.
 * Everything here is interface-only so the three layers build independently
 * and products can substitute any layer (e.g. a different frame provider)
 * without forking the editor.
 *
 * Persistence model: the command stack executes optimistically against local
 * timeline state and emits the equivalent `SequenceOperation[]` through
 * `TimelineEditorProps.onApplyOperations`. A rejected promise rolls the
 * command back — the server stays the source of truth, the editor stays
 * responsive.
 */

import type { SequenceClip, SequenceTimeline } from '../sequences/model'
import type { SequenceOperation } from '../sequences/operations'

// ---------------------------------------------------------------------------
// Engine: command stack
// ---------------------------------------------------------------------------

/** One undoable edit. `execute`/`undo` mutate ONLY local editor state; the
 *  emitted operations are the durable form sent to the product. */
export interface TimelineCommand {
  label: string
  execute(state: EditorTimelineState): EditorTimelineState
  undo(state: EditorTimelineState): EditorTimelineState
  /** Durable operations equivalent to `execute` (sent on commit). */
  operations(): SequenceOperation[]
  /** Durable operations equivalent to `undo` (sent when the user undoes a
   *  committed command). */
  inverseOperations(): SequenceOperation[]
}

/** Local editor state — the timeline plus volatile view state the server
 *  never sees. */
export interface EditorTimelineState {
  timeline: SequenceTimeline
  playheadFrame: number
  selectedClipIds: string[]
  zoom: number
  scrollLeft: number
}

export interface CommandStack {
  execute(command: TimelineCommand): void
  undo(): void
  redo(): void
  canUndo(): boolean
  canRedo(): boolean
  /** Subscribe to state changes; returns an unsubscribe. */
  subscribe(listener: () => void): () => void
  getState(): EditorTimelineState
  /** Replace timeline state from a server refresh WITHOUT clearing history. */
  reset(timeline: SequenceTimeline): void
}

// ---------------------------------------------------------------------------
// Engine: zoom, snap, playback
// ---------------------------------------------------------------------------

/** Exponential zoom mapping so the slider feels linear across a 10x+ range.
 *  zoom = pixels per frame. */
export interface ZoomMath {
  sliderToZoom(slider: number): number
  zoomToSlider(zoom: number): number
  minZoom: number
  maxZoom: number
}

export interface SnapPoint {
  frame: number
  kind: 'clip-start' | 'clip-end' | 'playhead' | 'sequence-end'
}

export interface SnapResult {
  frame: number
  snapped: boolean
  point: SnapPoint | null
}

/** rAF-driven playback clock. `performance.now()` deltas drive the playhead;
 *  emits one callback per animation frame while playing. */
export interface PlaybackClock {
  play(): void
  pause(): void
  seek(frame: number): void
  isPlaying(): boolean
  getFrame(): number
  subscribe(listener: (frame: number) => void): () => void
  dispose(): void
}

// ---------------------------------------------------------------------------
// Media: frames, waveforms, transcription
// ---------------------------------------------------------------------------

/** Supplies decoded frames for preview rendering. The baseline implementation
 *  seeks an off-DOM HTMLVideoElement (works everywhere); a WebCodecs
 *  implementation can replace it behind the same seam. */
export interface VideoFrameProvider {
  /** Draw the frame at `sourceSeconds` into `ctx` at the given rect. Resolves
   *  when the frame is painted; rejects when the media cannot be decoded. */
  drawFrame(
    mediaUrl: string,
    sourceSeconds: number,
    ctx: CanvasRenderingContext2D,
    rect: { x: number; y: number; width: number; height: number },
  ): Promise<void>
  /** Pre-warm a media URL so the first `drawFrame` doesn't stall. */
  prefetch(mediaUrl: string): void
  dispose(): void
}

/** min/max sample peaks per pixel bucket for waveform rendering. */
export interface WaveformData {
  peaks: Float32Array
  /** Samples represented per peak pair. */
  samplesPerBucket: number
  durationSeconds: number
}

export interface TranscriptionSegment {
  text: string
  startSeconds: number
  endSeconds: number
}

/** Whisper-in-a-worker contract. Implementations dynamically import the model
 *  runtime; `available` is false when the optional peer is not installed. */
export interface TranscriptionProvider {
  available: boolean
  transcribe(
    mediaUrl: string,
    opts?: { language?: string; onProgress?: (fraction: number) => void },
  ): Promise<TranscriptionSegment[]>
}

// ---------------------------------------------------------------------------
// Components: the editor's public props
// ---------------------------------------------------------------------------

export interface TimelineEditorProps {
  timeline: SequenceTimeline
  canWrite: boolean
  /** Persist operations the user produced. Reject to roll the edit back. */
  onApplyOperations(operations: SequenceOperation[]): Promise<void>
  /** Selection + playhead surface to the host (e.g. to attach agent context). */
  onSelectionChange?(clips: SequenceClip[]): void
  onPlayheadChange?(frame: number): void
  /** Host-rendered side panel (agent chat) and shelf (draggable assets). */
  renderSidePanel?(ctx: { selectedClips: SequenceClip[]; playheadFrame: number }): React.ReactNode
  renderAssetShelf?(): React.ReactNode
  /** Frame provider override; omitted → the baseline HTMLVideoElement provider. */
  frameProvider?: VideoFrameProvider
  className?: string
}
