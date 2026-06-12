/**
 * Playhead overlay for the track area: a full-height line with a triangular
 * cap. Positioned in timeline pixels (frame * zoom) inside the scrolled
 * content, so it moves with horizontal scroll for free. Pointer-transparent —
 * scrubbing belongs to the ruler.
 */

export interface TimelinePlayheadProps {
  frame: number
  zoom: number
}

export function TimelinePlayhead({ frame, zoom }: TimelinePlayheadProps) {
  return (
    <div
      data-timeline-playhead
      className="pointer-events-none absolute bottom-0 top-0 z-20"
      style={{ left: `${frame * zoom}px` }}
    >
      <div className="absolute bottom-0 top-0 w-px bg-[var(--brand-primary)] shadow-[0_0_10px_var(--brand-primary)]" />
      <div
        className="absolute -left-[5px] top-0 h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent"
        style={{ borderTopColor: 'var(--brand-primary)' }}
      />
    </div>
  )
}
