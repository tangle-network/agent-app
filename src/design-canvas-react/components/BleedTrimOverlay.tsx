/**
 * Semi-transparent bleed tint drawn OUTSIDE the page bounds, with trim-mark
 * corner indicators. Renders as an absolutely-positioned div layered over the
 * workspace canvas; node name 'overlay:bleed' lets automated tests target it.
 *
 * Conditionally rendered: parent mounts this only when `showBleed && bleed`.
 * All dimensions are in SCREEN pixels (caller applies the zoom factor).
 */

import type { PageBleed } from '../../design-canvas/model'

export interface BleedTrimOverlayProps {
  /** Page dimensions in screen pixels (already multiplied by zoom). */
  pageWidthPx: number
  pageHeightPx: number
  /** Bleed extents in SCREEN pixels (caller multiplies doc-px by zoom). */
  bleed: {
    top: number
    right: number
    bottom: number
    left: number
  }
}

/** Length in screen pixels of each trim-mark arm. */
const TRIM_MARK_PX = 12

/** How far trim marks sit from the page corner (in screen px). */
const TRIM_MARK_OFFSET_PX = 4

export function BleedTrimOverlay({ pageWidthPx, pageHeightPx, bleed }: BleedTrimOverlayProps) {
  const totalW = bleed.left + pageWidthPx + bleed.right
  const totalH = bleed.top + pageHeightPx + bleed.bottom

  return (
    <div
      data-node="overlay:bleed"
      className="pointer-events-none absolute"
      style={{
        top: -bleed.top,
        left: -bleed.left,
        width: totalW,
        height: totalH,
      }}
      aria-hidden
    >
      {/* Bleed tint strips — four sides */}
      {/* top */}
      <div
        className="absolute bg-rose-500/10"
        style={{ top: 0, left: 0, width: totalW, height: bleed.top }}
      />
      {/* bottom */}
      <div
        className="absolute bg-rose-500/10"
        style={{ bottom: 0, left: 0, width: totalW, height: bleed.bottom }}
      />
      {/* left */}
      <div
        className="absolute bg-rose-500/10"
        style={{ top: bleed.top, left: 0, width: bleed.left, height: pageHeightPx }}
      />
      {/* right */}
      <div
        className="absolute bg-rose-500/10"
        style={{ top: bleed.top, right: 0, width: bleed.right, height: pageHeightPx }}
      />

      {/* Trim marks — one per corner, two lines each */}
      <TrimMark corner="tl" bleed={bleed} />
      <TrimMark corner="tr" bleed={bleed} pageWidthPx={pageWidthPx} />
      <TrimMark corner="bl" bleed={bleed} pageHeightPx={pageHeightPx} />
      <TrimMark corner="br" bleed={bleed} pageWidthPx={pageWidthPx} pageHeightPx={pageHeightPx} />
    </div>
  )
}

type Corner = 'tl' | 'tr' | 'bl' | 'br'

interface TrimMarkProps {
  corner: Corner
  bleed: BleedTrimOverlayProps['bleed']
  pageWidthPx?: number
  pageHeightPx?: number
}

function TrimMark({ corner, bleed, pageWidthPx = 0, pageHeightPx = 0 }: TrimMarkProps) {
  const isRight = corner === 'tr' || corner === 'br'
  const isBottom = corner === 'bl' || corner === 'br'

  const xBase = isRight ? bleed.left + pageWidthPx : bleed.left
  const yBase = isBottom ? bleed.top + pageHeightPx : bleed.top

  // Horizontal arm
  const hX = isRight ? xBase + TRIM_MARK_OFFSET_PX : xBase - TRIM_MARK_OFFSET_PX - TRIM_MARK_PX
  const hY = yBase - 0.5

  // Vertical arm
  const vX = xBase - 0.5
  const vY = isBottom ? yBase + TRIM_MARK_OFFSET_PX : yBase - TRIM_MARK_OFFSET_PX - TRIM_MARK_PX

  return (
    <>
      <div
        className="absolute bg-[var(--text-muted)]"
        style={{ left: hX, top: hY, width: TRIM_MARK_PX, height: 1 }}
      />
      <div
        className="absolute bg-[var(--text-muted)]"
        style={{ left: vX, top: vY, width: 1, height: TRIM_MARK_PX }}
      />
    </>
  )
}
