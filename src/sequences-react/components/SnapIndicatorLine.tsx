/**
 * Vertical accent line at the frame an in-flight drag is snapped to. Rendered
 * inside the horizontally-scrolled track area so its x position is plain
 * frame * zoom; visibility is owned by the editor (non-null point = visible).
 */

import type { SnapPoint } from '../contracts'

export interface SnapIndicatorLineProps {
  point: SnapPoint | null
  zoom: number
}

export function SnapIndicatorLine({ point, zoom }: SnapIndicatorLineProps) {
  if (!point) return null
  return (
    <div
      data-snap-kind={point.kind}
      className="pointer-events-none absolute bottom-0 top-0 z-30 w-px bg-[var(--brand-primary)] shadow-[0_0_8px_var(--brand-primary)]"
      style={{ left: `${point.frame * zoom}px` }}
    />
  )
}
