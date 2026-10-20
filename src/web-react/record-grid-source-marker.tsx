/** Source-basis disclosure for a record cell. */
import { useCallback } from 'react'
import { OVERLAY_SHADOW, PopoverSurface, usePopover } from './controls'
import type { RecordGridCellSource, RecordGridSourceBasis } from './record-grid-model'

const BASIS_TONES: Record<RecordGridSourceBasis, string> = {
  extracted: 'border-primary/60 text-primary',
  entered: 'border-success/60 text-success',
  computed: 'border-border text-muted-foreground',
  asserted: 'border-warning/60 text-warning',
}

const BASIS_TITLES: Record<RecordGridSourceBasis, string> = {
  extracted: 'Extracted from a source document',
  entered: 'Confirmed by a person',
  computed: 'Computed from other values',
  asserted: 'Agent, unverified — no source recorded',
}

interface SourceMarkerProps {
  panelId: string
  columnHeader: string
  rowLabel: string
  source: RecordGridCellSource
  open: boolean
  onToggle: () => void
}

/**
 * The per-cell provenance affordance: a marker that opens the quote, the
 * source's name, and a link to it.
 *
 * Renders its panel through `PopoverSurface` (not an in-place `absolute`
 * span): the grid is a scrollable table by construction — `overflow-x-auto`/
 * `overflow-y-auto` on the scroll region is the whole reason `RecordGrid`
 * stays usable with many columns/rows — and that scroll container clips every
 * positioned descendant whose containing block sits inside it exactly the way
 * the composer's control rail clipped the model/thinking menus (see AGENTS.md
 * "UI chrome ownership (picker canon)"). `open` stays parent-owned (only one
 * marker across the grid may be open at a time); `usePopover` never calls
 * `setOpen(true)` itself — its listeners only run while `open` is already
 * true — so translating its `setOpen(false)` into the existing `onToggle`
 * flip is safe.
 */
export function SourceMarker({ panelId, columnHeader, rowLabel, source, open, onToggle }: SourceMarkerProps) {
  // An omitted basis is the DEFAULT path every first integration takes, so it
  // must resolve to the weakest claim, not the strongest. `extracted` (and
  // `source` before the rename) told the reader the figure was read out of a
  // document the caller never named — a factual claim about a document that may
  // not exist. `asserted` is the union's own "nothing outside the model behind
  // it", which is exactly what a caller who stated no basis has established.
  const basis: RecordGridSourceBasis = source.basis ?? 'asserted'
  const setOpen = useCallback(
    (next: boolean) => {
      if (!next) onToggle()
    },
    [onToggle],
  )
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(open, setOpen)
  return (
    <span ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        {...triggerProps}
        aria-label={`Source for ${columnHeader}, ${rowLabel}`}
        aria-controls={open ? panelId : undefined}
        title={BASIS_TITLES[basis]}
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
        className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${BASIS_TONES[basis]}`}
      >
        <svg
          viewBox="0 0 24 24"
          className="h-2.5 w-2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M9 8h6M9 12h6M9 16h3" />
        </svg>
      </button>
      <PopoverSurface
        open={open}
        id={panelId}
        role="note"
        triggerRef={triggerRef}
        panelRef={panelRef}
        className={`w-64 rounded-lg border border-card-edge bg-popover p-3 text-left ${OVERLAY_SHADOW}`}
      >
        {source.quote && (
          <span className="block border-l-2 border-primary/50 pl-2 text-xs italic leading-snug text-foreground">
            “{source.quote}”
          </span>
        )}
        <span className="mt-2 block text-xs text-muted-foreground">
          {source.label ?? 'Source'}
          {source.locator ? ` · ${source.locator}` : ''}
          {` · ${BASIS_TITLES[basis]}`}
        </span>
        {source.href && (
          <a
            href={source.href}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="mt-1.5 inline-block text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            Open source
          </a>
        )}
      </PopoverSurface>
    </span>
  )
}
