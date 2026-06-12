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
}

export function ZoomControl({ zoomMath, zoom, onZoomChange }: ZoomControlProps) {
  const sliderMin = zoomMath.zoomToSlider(zoomMath.minZoom)
  const sliderMax = zoomMath.zoomToSlider(zoomMath.maxZoom)
  const sliderStep = (sliderMax - sliderMin) / 100
  const slider = zoomMath.zoomToSlider(zoom)

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
        className="flex h-6 w-6 items-center justify-center rounded border border-[var(--border-default)] text-sm leading-none text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      >
        −
      </button>
      <input
        type="range"
        aria-label="Timeline zoom"
        min={sliderMin}
        max={sliderMax}
        step={sliderStep}
        value={slider}
        onChange={(event) => setSlider(Number(event.target.value))}
        className="h-1 w-24 cursor-pointer accent-[var(--brand-primary)]"
      />
      <button
        type="button"
        aria-label="Zoom in"
        onClick={() => setSlider(slider + sliderStep * 10)}
        className="flex h-6 w-6 items-center justify-center rounded border border-[var(--border-default)] text-sm leading-none text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      >
        +
      </button>
    </div>
  )
}
