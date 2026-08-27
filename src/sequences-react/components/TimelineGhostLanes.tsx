/**
 * Labeled placeholder lanes drawn behind the empty state so the surface reads
 * as a timeline before any track exists: a "Video" lane and a "Captions" lane
 * with the same sticky header column the real `TimelineTrackRow` uses, sized to
 * the timeline width so the ruler's timecodes line up over real lanes. Purely
 * decorative — no clips, no gestures.
 */

import { CaptionGlyph, FilmGlyph } from './glyphs'

export interface TimelineGhostLanesProps {
  /** Timeline pixel width (durationFrames * zoom), so ghost lanes match the ruler. */
  laneWidth: number
  videoLabel: string
  captionLabel: string
}

function GhostLane({
  label,
  icon: Icon,
  height,
  laneWidth,
}: {
  label: string
  icon: (p: { className?: string }) => React.ReactNode
  height: string
  laneWidth: number
}) {
  return (
    <div className="flex border-b border-[var(--border-default)] last:border-b-0 opacity-60">
      <div
        className={`sticky left-0 z-10 flex w-36 shrink-0 items-center gap-2 border-r border-[var(--border-default)] bg-[var(--bg-input)] px-2.5 ${height}`}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text-muted)]">{label}</span>
      </div>
      <div className={`${height}`} style={{ width: `${laneWidth}px` }} />
    </div>
  )
}

export function TimelineGhostLanes({ laneWidth, videoLabel, captionLabel }: TimelineGhostLanesProps) {
  return (
    <div data-timeline-ghost-lanes aria-hidden className="pointer-events-none absolute inset-0">
      <GhostLane label={videoLabel} icon={FilmGlyph} height="h-16" laneWidth={laneWidth} />
      <GhostLane label={captionLabel} icon={CaptionGlyph} height="h-9" laneWidth={laneWidth} />
    </div>
  )
}
