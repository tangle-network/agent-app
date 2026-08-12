/**
 * `ProvenanceValue` — one value rendered so its origin is discoverable without
 * navigating away, and openable when there is something to open.
 *
 * This is the affordance three verticals each rebuilt: tax renders a source
 * quote under an expanded return line, legal renders authorities under a
 * finding, the record grid renders a per-cell marker. Same product promise,
 * three vocabularies, three sets of gaps.
 *
 * What the primitive holds that a hand-rolled caption does not:
 *
 * 1. The four bases render differently — a person's entry and a model's
 *    assertion are never the same pixels. Each carries its own glyph AND its
 *    own words, so the distinction survives greyscale and a screen reader.
 * 2. It COMPOSES. A computed value's provenance is its inputs, and each input
 *    is itself a `ProvenanceValue` with its own disclosure.
 * 3. Confidence renders as the next move ("Check the source"), never as a
 *    percentage a reader cannot act on.
 * 4. The disclosure is a real button — keyboard reachable, `aria-expanded`,
 *    Escape closes and returns focus, a click outside dismisses, and opening
 *    one trail closes the one the reader left. Nothing here discloses on hover,
 *    and no fact lives only in a `title` attribute.
 * 5. A source that is loading, unopenable, or absent SAYS so. There is no path
 *    through this component that renders a bare number.
 *
 * Layout: an inline-block block-level element, so put it in a table cell, a
 * list item, or a card — not inside a `<p>`. Sandbox-ui-free, like the rest of
 * `/web-react`; the model in `./provenance-model` is React-free.
 */

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

import {
  describeProvenance,
  describeProvenanceSourceStatus,
  loadingProvenanceSources,
  provenanceBasisMeta,
  provenanceGaps,
  provenanceNextMove,
  provenanceStandingMeta,
  provenanceTriggerLabel,
  rollUpProvenanceStanding,
  type ProvenanceBasis,
  type ProvenanceConfidencePolicy,
  type ProvenanceRecord,
  type ProvenanceSource,
  type ProvenanceStanding,
} from './provenance-model'

export * from './provenance-model'

// ── marker vocabulary ─────────────────────────────────────────────────────

// Tone AND glyph differ per basis. Colour alone fails the reader who cannot
// see it and the one whose theme flattens it; the words in
// `provenanceBasisMeta` carry the same distinction a third time.
const BASIS_TONES: Record<ProvenanceBasis, string> = {
  extracted: 'border-primary/30 bg-primary/10 text-primary',
  entered: 'border-success/30 bg-success/10 text-success',
  computed: 'border-border bg-secondary text-foreground',
  asserted: 'border-warning/40 bg-warning/10 text-warning',
}

const STANDING_TONES: Record<ProvenanceStanding, string> = {
  settled: 'text-muted-foreground',
  check: 'text-warning',
  confirm: 'text-destructive',
}

function BasisGlyph({ basis, className }: { basis: ProvenanceBasis; className?: string }) {
  const shared = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className,
  }
  switch (basis) {
    case 'extracted':
      return (
        <svg {...shared}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <polyline points="14 3 14 8 19 8" />
          <line x1="9" y1="13" x2="15" y2="13" />
        </svg>
      )
    case 'entered':
      return (
        <svg {...shared}>
          <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      )
    case 'computed':
      return (
        <svg {...shared}>
          <line x1="4" y1="9" x2="20" y2="9" />
          <line x1="4" y1="15" x2="20" y2="15" />
          <line x1="10" y1="3" x2="8" y2="21" />
          <line x1="16" y1="3" x2="14" y2="21" />
        </svg>
      )
    case 'asserted':
      return (
        <svg {...shared}>
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
          <circle cx="12" cy="12" r="3.2" />
        </svg>
      )
  }
}

// ── open panels ───────────────────────────────────────────────────────────

interface OpenPanel {
  root: HTMLElement
  close: () => void
}

// Two trails open beside each other leave the reader matching a quote to a
// number by position, which is the failure a marker adjacent to its own value
// exists to remove.
const openPanels = new Set<OpenPanel>()

/**
 * Close every open trail this one does not sit INSIDE. A composed input's panel
 * is nested in its parent's, so closing "everything else" would close the row
 * the reader just drilled into — an ancestor stays open.
 *
 * Only a reader opening a trail closes another one. A `defaultOpen` surface has
 * deliberately asked for several trails at once, and mount order is not a
 * decision anyone made.
 */
function closeTrailsOutside(root: HTMLElement | null): void {
  for (const other of Array.from(openPanels)) {
    if (root === null || !other.root.contains(root)) other.close()
  }
}

// ── props ─────────────────────────────────────────────────────────────────

/** Properties for one provenanced value and its disclosure. */
export interface ProvenanceValueProps {
  /** The value and where it came from. */
  record: ProvenanceRecord
  /**
   * Open one source in the product's own way (a document pane at the right
   * page, a drawer, a route). Takes precedence over `href` when both are
   * present, because a product that routes wants its router — a source with
   * neither is named but not openable, which is a legitimate state and is
   * rendered as such.
   */
  onOpenSource?: (source: ProvenanceSource, record: ProvenanceRecord) => void
  /** Retry resolving an `unavailable` source. Absent → the failure is stated
   *  without a retry control, never swallowed. */
  onRetrySource?: (source: ProvenanceSource, record: ProvenanceRecord) => void
  /** Where this product draws its confidence lines. */
  confidencePolicy?: ProvenanceConfidencePolicy
  /**
   * How many levels of composed inputs stay expandable. Past it an input still
   * renders its value, its basis and its origin sentence — it just stops
   * carrying its own disclosure, so a deep tree cannot run away and a record
   * that reaches itself cannot recurse forever. Default 2.
   */
  maxDepth?: number
  /** Open the disclosure on first render — for a review surface where the
   *  trail is the point. Several of these coexist: only a reader opening a
   *  trail closes another one. */
  defaultOpen?: boolean
  /** What an empty `display` renders as. A blank cell is the defect this
   *  component exists to remove. */
  missingValueLabel?: string
  className?: string
}

const DEFAULT_MISSING_VALUE_LABEL = 'No value recorded'

// ── source rows ───────────────────────────────────────────────────────────

function SourceRow({
  source,
  record,
  onOpenSource,
  onRetrySource,
}: {
  source: ProvenanceSource
  record: ProvenanceRecord
  onOpenSource?: (source: ProvenanceSource, record: ProvenanceRecord) => void
  onRetrySource?: (source: ProvenanceSource, record: ProvenanceRecord) => void
}) {
  const status = source.status ?? 'ready'
  const statusLine = describeProvenanceSourceStatus(source)
  const openable = status === 'ready' && (onOpenSource !== undefined || source.href !== undefined)

  return (
    <li className="rounded-md border border-card-edge bg-card px-2.5 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-foreground">{source.label}</span>
        {source.locator && <span className="text-xs text-muted-foreground">{source.locator}</span>}
        {openable &&
          (onOpenSource ? (
            <button
              type="button"
              onClick={() => onOpenSource(source, record)}
              className="rounded px-1 text-xs font-medium text-primary underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open {source.label}
            </button>
          ) : (
            <a
              href={source.href}
              target="_blank"
              rel="noreferrer"
              className="rounded px-1 text-xs font-medium text-primary underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open {source.label}
            </a>
          ))}
      </div>
      {source.quote && (
        <blockquote className="mt-1 border-l-2 border-primary/50 pl-2 text-[12px] italic leading-snug text-foreground">
          “{source.quote}”
        </blockquote>
      )}
      {statusLine && (
        // `role="status"` and not `alert`: the reader opened this panel, so the
        // update is theirs to read, not an interruption. Either way it is TEXT
        // — a spinner alone and a greyed row alone both render as "nothing
        // here".
        <p
          role="status"
          className={`mt-1 text-xs ${status === 'unavailable' ? 'text-destructive' : 'text-muted-foreground'}`}
        >
          {statusLine}
          {status === 'unavailable' && onRetrySource && (
            <button
              type="button"
              onClick={() => onRetrySource(source, record)}
              className="ml-2 rounded border border-border px-1.5 py-0.5 text-xs font-medium text-foreground hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Try again
            </button>
          )}
        </p>
      )}
    </li>
  )
}

// ── the value ─────────────────────────────────────────────────────────────

/**
 * A value, its origin marker, and the disclosure that shows where it came
 * from. The marker states the basis in words and, whenever there is something
 * to do about the value, the next move — so the standing is legible at rest
 * and does not depend on anyone opening the panel.
 */
export function ProvenanceValue({
  record,
  onOpenSource,
  onRetrySource,
  confidencePolicy,
  maxDepth = 2,
  defaultOpen = false,
  missingValueLabel = DEFAULT_MISSING_VALUE_LABEL,
  className,
}: ProvenanceValueProps) {
  const [open, setOpen] = useState(defaultOpen)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelId = useId()

  const standing = rollUpProvenanceStanding(record, confidencePolicy)
  const basisMeta = provenanceBasisMeta(record.basis)
  const standingMeta = provenanceStandingMeta(standing)
  const gaps = provenanceGaps(record)
  const loading = loadingProvenanceSources(record)
  const sources = record.sources ?? []
  const inputs = record.inputs ?? []
  const hasValue = record.display.trim() !== ''

  // Escape closes the value the focus is inside and hands focus back to its own
  // trigger; `stopPropagation` keeps a nested input from also closing the
  // parent that contains it.
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Escape' || !open) return
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    },
    [open],
  )

  // Opening is a reader's decision, so it is the one moment another trail is
  // closed — see `closeTrailsOutside`.
  const onToggle = useCallback(() => {
    if (!open) closeTrailsOutside(rootRef.current)
    setOpen(!open)
  }, [open])

  // A click landing anywhere else dismisses the trail. Registered in the
  // capture phase so a product's own click handler under the pointer cannot
  // swallow it, and paired with the registry above so the two dismissals agree.
  useEffect(() => {
    const root = rootRef.current
    if (!open || root === null) return

    const entry: OpenPanel = { root, close: () => setOpen(false) }
    openPanels.add(entry)

    const onPointerDown = (event: Event) => {
      const target = event.target
      if (target instanceof Node && root.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('touchstart', onPointerDown, true)

    return () => {
      openPanels.delete(entry)
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('touchstart', onPointerDown, true)
    }
  }, [open])

  const summary: ReactNode = (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      {record.label && <span className="text-xs text-muted-foreground">{record.label}</span>}
      <span className={hasValue ? 'text-sm text-foreground' : 'text-sm italic text-muted-foreground'}>
        {hasValue ? record.display : missingValueLabel}
      </span>
    </span>
  )

  // Depth exhausted: still the value, still the basis, still the origin
  // sentence — only the disclosure goes. A truncated tree must not silently
  // become a bare number.
  if (maxDepth <= 0) {
    return (
      <div
        className={`inline-block max-w-full ${className ?? ''}`}
        data-provenance-basis={record.basis}
        data-provenance-standing={standing}
      >
        {summary}
        <span
          className={`ml-1.5 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs font-medium ${BASIS_TONES[record.basis]}`}
        >
          <BasisGlyph basis={record.basis} className="h-3 w-3" />
          {basisMeta.label}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{describeProvenance(record)}</span>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className={`inline-block max-w-full ${className ?? ''}`}
      onKeyDown={onKeyDown}
      data-provenance-basis={record.basis}
      data-provenance-standing={standing}
    >
      <span className="inline-flex flex-wrap items-baseline gap-1.5">
        {summary}
        <button
          ref={triggerRef}
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={provenanceTriggerLabel(record, standing)}
          className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs font-medium transition hover:brightness-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${BASIS_TONES[record.basis]}`}
        >
          <BasisGlyph basis={record.basis} className="h-3 w-3" />
          <span aria-hidden>{basisMeta.label}</span>
        </button>
        {standing !== 'settled' && (
          // Legible at rest: what to do about the value does not wait for
          // someone to open the panel. `aria-hidden` because the trigger's
          // accessible name already carries it — this is the visual half.
          <span aria-hidden className={`text-xs font-medium ${STANDING_TONES[standing]}`}>
            {standingMeta.label}
          </span>
        )}
      </span>

      {open && (
        <div
          id={panelId}
          role="group"
          aria-label={provenanceTriggerLabel(record, standing)}
          className="mt-1.5 w-full min-w-0 space-y-2 rounded-lg border border-border bg-card px-3 py-2.5 text-left"
        >
          <div>
            <p className="text-[12px] leading-snug text-foreground">{describeProvenance(record)}</p>
            <p className={`mt-0.5 text-xs leading-snug ${STANDING_TONES[standing]}`}>
              {standingMeta.label} — {provenanceNextMove(record, standing, confidencePolicy)}
            </p>
            {basisMeta.checkableAgainst === null && (
              <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                {basisMeta.meaning} There is nothing outside the model to check it against.
              </p>
            )}
          </div>

          {sources.length > 0 && (
            <ul className="space-y-1.5">
              {sources.map((source, index) => (
                <SourceRow
                  key={`${source.label}-${source.locator ?? ''}-${index}`}
                  source={source}
                  record={record}
                  onOpenSource={onOpenSource}
                  onRetrySource={onRetrySource}
                />
              ))}
            </ul>
          )}

          {gaps
            .filter((gap) => gap.kind !== 'unavailable-source')
            .map((gap) => (
              // An unavailable source already states itself on its own row; a
              // structural gap has no row to state it, so it gets one here.
              <p key={gap.kind} className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs leading-snug text-destructive">
                {gap.message}
              </p>
            ))}

          {loading.length > 0 && sources.length === 0 && (
            <p role="status" className="text-xs text-muted-foreground">
              Looking up where this came from…
            </p>
          )}

          {inputs.length > 0 && (
            <div className="border-t border-border pt-2">
              <p className="text-xs font-medium uppercase tracking-[0.05em] text-muted-foreground">
                {record.derivation ? `Computed from ${record.derivation}` : 'Computed from'}
              </p>
              <ul className="mt-1.5 space-y-1.5">
                {inputs.map((input, index) => (
                  <li key={`${input.label ?? input.display}-${index}`}>
                    <ProvenanceValue
                      record={input}
                      onOpenSource={onOpenSource}
                      onRetrySource={onRetrySource}
                      confidencePolicy={confidencePolicy}
                      maxDepth={maxDepth - 1}
                      missingValueLabel={missingValueLabel}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Properties for the basis legend. */
export interface ProvenanceLegendProps {
  /** Only the bases present on screen. Passing all four when only two appear
   *  teaches distinctions the reader cannot use. */
  bases: readonly ProvenanceBasis[]
  className?: string
}

/** The marker key for a surface that renders several bases at once — a review
 *  pane, a grid, a return. Each row is the same glyph, tone and words the
 *  markers use, plus what the basis MEANS. */
export function ProvenanceLegend({ bases, className }: ProvenanceLegendProps) {
  if (bases.length === 0) return null
  return (
    <ul className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 ${className ?? ''}`}>
      {bases.map((basis) => {
        const meta = provenanceBasisMeta(basis)
        return (
          <li key={basis} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs font-medium ${BASIS_TONES[basis]}`}
            >
              <BasisGlyph basis={basis} className="h-3 w-3" />
              {meta.label}
            </span>
            <span>{meta.meaning}</span>
          </li>
        )
      })}
    </ul>
  )
}
