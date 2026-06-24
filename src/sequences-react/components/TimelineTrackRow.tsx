/**
 * One track: a sticky-left header (name, kind glyph, lock/mute state) and a
 * lane sized in timeline pixels (durationFrames * zoom) carrying a
 * `TimelineClipChip` per clip. The lane advertises itself through
 * `data-lane-track`/`data-lane-kind`/`data-lane-locked` — the geometry chips
 * read for vertical drag retargeting. Clicking empty lane space seeks the
 * playhead.
 */

import type { PointerEvent as ReactPointerEvent } from 'react'
import type { SequenceClip, SequenceTrack, SequenceTrackKind } from '../../sequences/model'
import type { SnapPoint, VideoFrameProvider } from '../contracts'
import { TimelineClipChip } from './TimelineClipChip'
import type { ClipMoveCommit, ClipTrimCommit } from './TimelineClipChip'
import { AgentGlyph, AudioGlyph, CaptionGlyph, FilmGlyph, LockGlyph, MutedGlyph, ReferenceGlyph } from './glyphs'

const LANE_HEIGHTS: Record<SequenceTrackKind, string> = {
  video: 'h-16',
  reference: 'h-16',
  audio: 'h-14',
  caption: 'h-9',
  agent: 'h-9',
}

const KIND_GLYPHS: Record<SequenceTrackKind, (props: { className?: string }) => React.ReactNode> = {
  video: FilmGlyph,
  audio: AudioGlyph,
  caption: CaptionGlyph,
  reference: ReferenceGlyph,
  agent: AgentGlyph,
}

export interface TimelineTrackRowProps {
  track: SequenceTrack
  clips: SequenceClip[]
  fps: number
  zoom: number
  sequenceDurationFrames: number
  selectedClipIds: ReadonlySet<string>
  /** The single clip that carries tabIndex 0 (roving tabindex); null seeds the
   *  first chip in the editor as the lone Tab stop. */
  tabbableClipId: string | null
  canWrite: boolean
  frameProvider: VideoFrameProvider
  snapMove(candidate: { startFrame: number; durationFrames: number; clipId: string }): { startFrame: number; point: SnapPoint | null }
  snapEdge(candidate: { frame: number; clipId: string }): { frame: number; point: SnapPoint | null }
  onSnapPointChange(point: SnapPoint | null): void
  onSelectClip(clipId: string, additive: boolean): void
  onRequestDeleteClip(clipId: string): void
  onFocusStepClip(clipId: string, direction: -1 | 1): void
  onCommitMove(input: ClipMoveCommit): void
  onCommitTrim(input: ClipTrimCommit): void
  onCommitText(input: { clipId: string; text: string }): void
  onLaneSeek(frame: number): void
}

export function TimelineTrackRow(props: TimelineTrackRowProps) {
  const { track, clips, fps, zoom, sequenceDurationFrames } = props
  const Glyph = KIND_GLYPHS[track.kind]
  const laneHeight = LANE_HEIGHTS[track.kind]

  function handleLanePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    // Chips stop propagation; a pointerdown reaching the lane is empty space.
    if (event.button !== 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const frame = Math.max(0, Math.min(sequenceDurationFrames, Math.round((event.clientX - rect.left) / zoom)))
    props.onLaneSeek(frame)
  }

  return (
    <div className="flex border-b border-[var(--border-default)] last:border-b-0">
      <div className={`sticky left-0 z-10 flex w-36 shrink-0 items-center gap-2 border-r border-[var(--border-default)] bg-[var(--bg-input)] px-2.5 ${laneHeight}`}>
        <Glyph className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text-secondary)]">{track.name}</span>
        {track.locked ? <LockGlyph className="h-3 w-3 shrink-0 text-[var(--text-warning)]" /> : null}
        {track.muted ? <MutedGlyph className="h-3 w-3 shrink-0 text-[var(--text-muted)]" /> : null}
      </div>
      <div
        data-lane-track={track.id}
        data-lane-kind={track.kind}
        data-lane-locked={track.locked ? 'true' : 'false'}
        className={`relative ${laneHeight} ${track.muted ? 'opacity-60' : ''}`}
        style={{ width: `${sequenceDurationFrames * zoom}px`, touchAction: 'none' }}
        onPointerDown={handleLanePointerDown}
      >
        {clips.map((clip) => (
          <TimelineClipChip
            key={clip.id}
            clip={clip}
            track={track}
            fps={fps}
            zoom={zoom}
            sequenceDurationFrames={sequenceDurationFrames}
            selected={props.selectedClipIds.has(clip.id)}
            canWrite={props.canWrite}
            tabbable={props.tabbableClipId === clip.id}
            frameProvider={props.frameProvider}
            snapMove={props.snapMove}
            snapEdge={props.snapEdge}
            onSnapPointChange={props.onSnapPointChange}
            onSelect={props.onSelectClip}
            onRequestDelete={props.onRequestDeleteClip}
            onFocusStep={props.onFocusStepClip}
            onCommitMove={props.onCommitMove}
            onCommitTrim={props.onCommitTrim}
            onCommitText={props.onCommitText}
          />
        ))}
      </div>
    </div>
  )
}
