/**
 * Active snap guides rendered as full-page-extent lines during drag gestures.
 * Renders into a dedicated Konva.Layer (name 'overlay:snap') so export logic
 * can exclude it.
 *
 * Guide line colors differ by kind so users can distinguish grid snaps (faint)
 * from element-edge/center snaps (accent) from saved ruler guides (blue).
 */

import { Layer, Line } from 'react-konva'
import type { SnapTarget, SnapTargetKind } from '../contracts'

export interface SnapGuidesOverlayProps {
  /** Page dimensions in document px. */
  pageWidth: number
  pageHeight: number
  /** Active vertical guide, or null when not snapping. */
  activeVertical: SnapTarget | null
  /** Active horizontal guide, or null when not snapping. */
  activeHorizontal: SnapTarget | null
  /** Screen px per document px — used to compute 1-px-screen stroke widths. */
  zoom: number
}

const KIND_COLOR: Record<SnapTargetKind, string> = {
  'grid':           '#a0a0a0',
  'guide':          '#3b82f6',
  'page-edge':      '#f59e0b',
  'page-center':    '#f59e0b',
  'element-edge':   '#f43f5e',
  'element-center': '#f43f5e',
}

export function SnapGuidesOverlay({
  pageWidth,
  pageHeight,
  activeVertical,
  activeHorizontal,
  zoom,
}: SnapGuidesOverlayProps) {
  if (!activeVertical && !activeHorizontal) return null

  const strokeWidth = 1 / zoom

  return (
    <Layer name="overlay:snap" listening={false}>
      {activeVertical && (
        <Line
          name="overlay:snap-vertical"
          points={[activeVertical.position, -99999, activeVertical.position, 99999]}
          stroke={KIND_COLOR[activeVertical.kind]}
          strokeWidth={strokeWidth}
          dash={[4 / zoom, 3 / zoom]}
          listening={false}
          perfectDrawEnabled={false}
        />
      )}
      {activeHorizontal && (
        <Line
          name="overlay:snap-horizontal"
          points={[-99999, activeHorizontal.position, 99999, activeHorizontal.position]}
          stroke={KIND_COLOR[activeHorizontal.kind]}
          strokeWidth={strokeWidth}
          dash={[4 / zoom, 3 / zoom]}
          listening={false}
          perfectDrawEnabled={false}
        />
      )}
    </Layer>
  )
}
