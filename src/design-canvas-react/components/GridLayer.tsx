/**
 * Grid overlay rendered beneath page content. Uses Konva.Layer with Konva.Line
 * nodes at `gridSize` document-px spacing. Grid lines are skipped entirely when
 * they would be closer than 4 screen pixels apart — below that density the grid
 * becomes visual noise rather than guidance.
 *
 * COORDINATE SYSTEM: the lines are authored in document space and wrapped in a
 * Group carrying the SAME (panX, panY, zoom) transform the content layer uses,
 * so the grid tracks the page exactly on pan and zoom. A Konva.Layer cannot
 * live inside a Group, so the transform is applied to an inner Group, not the
 * Layer. The grid is its own Layer (not merged into the content Layer) so the
 * content draws on top without per-frame z-ordering churn.
 *
 * All nodes carry the name prefix 'overlay:' so export logic can exclude this
 * layer from rasterization.
 */

import { Layer, Group, Line } from 'react-konva'
import { gridVisible } from './transform-math'

export interface GridLayerProps {
  /** Page width in document px. */
  pageWidth: number
  /** Page height in document px. */
  pageHeight: number
  /** Document px between grid lines. */
  gridSize: number
  /** Screen px per document px. */
  zoom: number
  /** Horizontal pan offset in screen px (content Group x). */
  panX: number
  /** Vertical pan offset in screen px (content Group y). */
  panY: number
  /** Grid line color. */
  color?: string
  /** Grid line opacity (0–1). */
  opacity?: number
}

export function GridLayer({
  pageWidth,
  pageHeight,
  gridSize,
  zoom,
  panX,
  panY,
  color = '#c0c0c0',
  opacity = 0.5,
}: GridLayerProps) {
  // Skip rendering when lines would be denser than 4 screen px.
  if (!gridVisible(gridSize, zoom, 4)) return null

  const verticals: number[] = []
  for (let x = gridSize; x < pageWidth; x += gridSize) {
    verticals.push(x)
  }

  const horizontals: number[] = []
  for (let y = gridSize; y < pageHeight; y += gridSize) {
    horizontals.push(y)
  }

  return (
    <Layer name="overlay:grid" listening={false}>
      <Group x={panX} y={panY} scaleX={zoom} scaleY={zoom}>
        {verticals.map((x) => (
          <Line
            key={`v-${x}`}
            name="overlay:grid-line"
            points={[x, 0, x, pageHeight]}
            stroke={color}
            strokeWidth={1 / zoom}
            opacity={opacity}
            listening={false}
            perfectDrawEnabled={false}
          />
        ))}
        {horizontals.map((y) => (
          <Line
            key={`h-${y}`}
            name="overlay:grid-line"
            points={[0, y, pageWidth, y]}
            stroke={color}
            strokeWidth={1 / zoom}
            opacity={opacity}
            listening={false}
            perfectDrawEnabled={false}
          />
        ))}
      </Group>
    </Layer>
  )
}
