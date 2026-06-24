/**
 * Zoom slider mapped through `ZoomMath` so equal slider travel feels like
 * equal zoom ratio. The slider's numeric domain is derived from the math
 * itself (`zoomToSlider(minZoom)..zoomToSlider(maxZoom)`) — this component
 * never assumes what scale the engine chose.
 */

import type { ZoomMath } from '../contracts'

export interface ZoomControlProps {
  zoomMath: ZoomMath
  zoom: number
  onZoomChange(zoom: number): void
  /** Fit-to-sequence pixels-per-frame; clicking the readout snaps back to it. */
  fitZoom?: number
}

/** Pixels-per-frame → a human "% of fit" readout. The slider's absolute scale
 *  is meaningless to a user; what they reason about is "how zoomed am I vs the
 *  view that shows the whole cut." When no fit reference is supplied we fall
 *  back to a 1px-per-frame baseline so the number is still stable and monotonic. */
function zoomPercent(zoom: number, fitZoom: number | undefined): number {
  const base = fitZoom && fitZoom > 0 ? fitZoom : 1
  return Math.round((zoom / base) * 100)
}

const ZOOM_STEP_BUTTON =
  'flex h-7 w-7 items-center justify-center rounded border border-[var(--border-default)] text-sm leading-none text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

export function ZoomControl({ zoomMath, zoom, onZoomChange, fitZoom }: ZoomControlProps) {
  const sliderMin = zoomMath.zoomToSlider(zoomMath.minZoom)
  const sliderMax = zoomMath.zoomToSlider(zoomMath.maxZoom)
  const sliderStep = (sliderMax - sliderMin) / 100
  const slider = zoomMath.zoomToSlider(zoom)
  const percent = zoomPercent(zoom, fitZoom)

  function setSlider(next: number) {
    const clamped = Math.max(sliderMin, Math.min(sliderMax, next))
    onZoomChange(zoomMath.sliderToZoom(clamped))
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        aria-label="Zoom out"
        onClick={() => setSlider(slider - sliderStep * 10)}
        className={ZOOM_STEP_BUTTON}
      >
        −
      </button>
      <input
        type="range"
        aria-label="Timeline zoom"
        aria-valuetext={`${percent}%`}
        min={sliderMin}
        max={sliderMax}
        step={sliderStep}
        value={slider}
        onChange={(event) => setSlider(Number(event.target.value))}
        className="hidden h-1 w-24 cursor-pointer accent-[var(--brand-primary)] sm:block"
      />
      <button
        type="button"
        aria-label="Zoom in"
        onClick={() => setSlider(slider + sliderStep * 10)}
        className={ZOOM_STEP_BUTTON}
      >
        +
      </button>
      <output
        aria-hidden
        title={fitZoom ? 'Zoom (100% = fits the whole sequence)' : 'Zoom'}
        onClick={fitZoom ? () => onZoomChange(fitZoom) : undefined}
        className={`w-11 select-none text-right font-mono text-[11px] tabular-nums text-[var(--text-muted)] ${
          fitZoom ? 'cursor-pointer hover:text-[var(--text-primary)]' : ''
        }`}
      >
        {percent}%
      </output>
    </div>
  )
}
