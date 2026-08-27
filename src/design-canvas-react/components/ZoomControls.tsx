/**
 * Canvas zoom controls: fit-to-page, 100%, zoom-out/in buttons, and a percent
 * readout. Stateless — zoom lives in the editor's view state, updated through
 * onZoom.
 */

import { ZoomFitGlyph } from './glyphs'
import { BTN_SM } from './icon-button'

export interface ZoomControlsProps {
  zoom: number
  onZoom(zoom: number): void
  onFit(): void
  /** Label/aria for the fit action. Defaults to "Fit to screen" — shorter and
   *  matching every other tool's wording for the same action. */
  fitLabel?: string
}

const STEP = 0.1
const MIN = 0.05
const MAX = 32

export function ZoomControls({ zoom, onZoom, onFit, fitLabel = 'Fit to screen' }: ZoomControlsProps) {
  function zoomOut() {
    onZoom(Math.max(MIN, parseFloat((zoom - STEP).toFixed(4))))
  }
  function zoomIn() {
    onZoom(Math.min(MAX, parseFloat((zoom + STEP).toFixed(4))))
  }
  function resetHundred() {
    onZoom(1)
  }

  return (
    <div className="flex items-center gap-1 px-2">
      <button
        type="button"
        aria-label={fitLabel}
        onClick={onFit}
        className={BTN_SM}
        title={`${fitLabel} (F)`}
      >
        <ZoomFitGlyph className="h-3.5 w-3.5" />
      </button>

      <button
        type="button"
        aria-label="Zoom out"
        onClick={zoomOut}
        disabled={zoom <= MIN}
        className={BTN_SM}
      >
        <span className="text-base leading-none">−</span>
      </button>

      <button
        type="button"
        aria-label="Reset to 100%"
        onClick={resetHundred}
        className="rounded px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-[var(--text-secondary)] transition hover:bg-[var(--border-default)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
        title="Reset to 100%"
      >
        {Math.round(zoom * 100)}%
      </button>

      <button
        type="button"
        aria-label="Zoom in"
        onClick={zoomIn}
        disabled={zoom >= MAX}
        className={BTN_SM}
      >
        <span className="text-sm leading-none">+</span>
      </button>
    </div>
  )
}
