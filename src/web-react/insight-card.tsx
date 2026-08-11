/**
 * `InsightCard` + `InsightDeck` — the number that moved, and the paged deck of
 * them.
 *
 * Every product on this shell computes insights already: `/spend` knows today's
 * burn against yesterday's, `/missions` knows how many runs landed, the eval
 * lanes know a pass rate per release. All of it renders as a line of text, so
 * the reader does the comparison in their head and the series behind the number
 * never reaches the screen at all.
 *
 * Two rules this surface exists to hold:
 *
 *  - **A delta needs a baseline.** `previous` absent means no delta is drawn —
 *    not a green `+0%`, which is the specific fabrication a hand-rolled card
 *    produces when it defaults its baseline to zero, and which reads as "we
 *    measured, nothing changed" when the truth is "we have nothing to compare
 *    against". {@link insightDelta} returns `null` rather than a zero.
 *  - **Direction is not sentiment.** Spend going up and missions going up are
 *    the same arrow and opposite news, so tone is a caller declaration
 *    (`polarity`), and the default is neutral. A card that paints every rise
 *    green teaches the reader to stop reading the label.
 *
 * The deck is built on `web-react/async` rather than a loading boolean, so it
 * inherits that module's invariant instead of restating it: `AsyncView` renders
 * `error` with its message and retry, and `empty` is reachable only from a load
 * that resolved — a failed fetch can never paint "No insights yet"
 * (`docs/async-state-module.md`).
 *
 * Motion: cards arrive with `.agent-arrive`, staggered by `--stagger-index`
 * from the deck, and a page turn remounts them so the next page arrives as a
 * sequence instead of swapping text under cards that never moved. Every piece
 * of that is decoration, carries no `data-motion`, and collapses under
 * `prefers-reduced-motion` — the live label included.
 *
 * The live label does NOT opt out, and the reasoning is worth stating because
 * the opposite reads plausible. What tells the reader a figure is still being
 * computed is the WORD (`liveLabel`, "Updating"): it is rendered only while
 * `live`, and a settled card does not render it at all. The sweep through its
 * glyphs is emphasis on a signal that is already there, not the signal. So a
 * reader who asked for less motion still sees the word — static, in the
 * shimmer's resting gradient, still legible, and still disappearing the moment
 * the figure is final. Nothing here overrides a request the reader made.
 */

import {
  isValidElement,
  useCallback,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react'

import { AsyncView, type AsyncEmptySpec, type AsyncResourceState } from './async'
import { joinClasses } from './class-names'
import { Sparkline, formatSparklineValue } from './sparkline'

// ── the delta, and its honesty rules ──────────────────────────────────────

export type InsightDirection = 'up' | 'down' | 'flat'

/** Which way is good news for THIS metric. `neutral` is the default because it
 *  is the only answer that is true for every metric. */
export type InsightPolarity = 'higher-is-better' | 'lower-is-better' | 'neutral'

export type InsightTone = 'positive' | 'negative' | 'neutral'

export interface InsightDelta {
  /** The baseline the move is measured against — rendered, so the delta is
   *  never a number floating free of what produced it. */
  readonly previous: number
  readonly absolute: number
  /** `null` when the baseline is `0`: a share of nothing is undefined, and
   *  "+∞%" or a silently-dropped percentage are both worse than the absolute. */
  readonly percent: number | null
  readonly direction: InsightDirection
}

/**
 * The move, or `null` when there is no honest one to state.
 *
 * `unknown` inputs on purpose: these arrive from a fetched payload, and the
 * cases that must not produce a delta — a missing baseline, a `null` from a
 * first-ever reading, a `NaN` from a producer's division — are exactly the ones
 * a narrower signature would let through as `0`.
 */
export function insightDelta(value: unknown, previous: unknown): InsightDelta | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (typeof previous !== 'number' || !Number.isFinite(previous)) return null
  const absolute = value - previous
  return {
    previous,
    absolute,
    percent: previous === 0 ? null : absolute / previous,
    direction: absolute > 0 ? 'up' : absolute < 0 ? 'down' : 'flat',
  }
}

/** Maps a direction onto good/bad news, which only the caller knows. */
export function insightDeltaTone(direction: InsightDirection, polarity: InsightPolarity = 'neutral'): InsightTone {
  if (direction === 'flat' || polarity === 'neutral') return 'neutral'
  const welcome: InsightDirection = polarity === 'higher-is-better' ? 'up' : 'down'
  return direction === welcome ? 'positive' : 'negative'
}

/**
 * The delta as words: direction, magnitude, and the baseline it is measured
 * against. Words rather than an arrow plus a bare number, because the arrow is
 * `aria-hidden` and a reader hearing "12%" learns nothing about which way.
 */
export function formatInsightDelta(delta: InsightDelta, format: (value: number) => string = formatSparklineValue): string {
  const from = format(delta.previous)
  if (delta.direction === 'flat') return `No change from ${from}`
  const word = delta.direction === 'up' ? 'Up' : 'Down'
  const magnitude =
    delta.percent === null ? format(Math.abs(delta.absolute)) : `${(Math.abs(delta.percent) * 100).toFixed(1)}%`
  return `${word} ${magnitude} from ${from}`
}

const TONE_CLASS: Record<InsightTone, string> = {
  positive: 'text-success',
  negative: 'text-destructive',
  neutral: 'text-muted-foreground',
}

const DIRECTION_GLYPH: Record<InsightDirection, string> = { up: '↑', down: '↓', flat: '→' }

/**
 * What a non-finite figure renders as.
 *
 * `Intl.NumberFormat.format(NaN)` is the string `"NaN"` and `Infinity` is `"∞"`,
 * so a producer's unguarded division lands on the card as though it were a
 * reading. On a surface whose entire job is "here is the number that moved",
 * printing a non-number in the figure slot is the worst available failure: it
 * looks measured. A dash says the opposite, and the delta is already suppressed
 * for the same input by {@link insightDelta}.
 */
const INSIGHT_UNAVAILABLE_GLYPH = '—'
/** The dash reads as nothing at all to a screen reader, so the words go beside
 *  it. Not "0", not the metric name alone — the state IS "no reading". */
const INSIGHT_UNAVAILABLE_LABEL = 'Not available'

// ── the card ──────────────────────────────────────────────────────────────

export interface InsightAction {
  label: string
  onClick: () => void
}

export interface InsightCardProps {
  /** What was measured, in the reader's words ("Spend today"). */
  title: string
  /** The number that moved. A `string` renders verbatim — a total the caller
   *  already formatted with its own currency — and takes no delta, because
   *  there is nothing to subtract. A non-finite number is not a measurement and
   *  renders as {@link INSIGHT_UNAVAILABLE_GLYPH}, never as "NaN" or "∞". */
  value: number | string
  /** "USD", "runs", "%" — the unit the number is in, beside it rather than
   *  glued into it, so the figure stays scannable. */
  unit?: string
  /** The baseline. Absent ⇒ the card renders the value and no delta. */
  previous?: number
  polarity?: InsightPolarity
  /** One number format for the value, the delta and the series, so the three
   *  cannot disagree about decimals on the same card. */
  format?: (value: number) => string
  series?: readonly number[]
  /** Names the series in its accessible label; defaults to the card's title. */
  seriesLabel?: string
  /** One line of context under the number — what the window is, what is
   *  excluded. Not a restatement of the title. */
  description?: string
  /** The next action for this insight. An element renders as supplied (a link,
   *  a dialog trigger); the object form renders the standard button. */
  action?: InsightAction | ReactElement
  /** The number is still being computed. The label's PRESENCE is the signal, so
   *  it reads the same with motion collapsed — see the module note. */
  live?: boolean
  liveLabel?: string
  className?: string
  style?: CSSProperties
}

export function InsightCard({
  title,
  value,
  unit,
  previous,
  polarity = 'neutral',
  format = formatSparklineValue,
  series,
  seriesLabel,
  description,
  action,
  live = false,
  liveLabel = 'Updating',
  className,
  style,
}: InsightCardProps): ReactElement {
  const delta = insightDelta(value, previous)
  const tone = delta ? insightDeltaTone(delta.direction, polarity) : 'neutral'
  // A `NaN`/`Infinity` from a producer is not a smaller number — it is the
  // absence of a reading, and it takes the unit with it: "∞ USD" and
  // "Not available USD" are both claims about a measurement nobody made.
  const unavailable = typeof value === 'number' && !Number.isFinite(value)
  const shown = typeof value === 'number' ? format(value) : value

  return (
    <article
      data-insight-card=""
      data-tone={tone}
      // `.agent-arrive` is the package's card entrance; the deck sets
      // `--stagger-index` through `style` so a page of them lands as a sequence.
      className={joinClasses('agent-arrive flex h-full flex-col rounded-xl border border-card-edge bg-card p-4', className)}
      style={style}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-medium text-muted-foreground">{title}</h3>
        {live ? (
          // No `data-motion` opt-out: the word is the signal and the sweep is
          // emphasis, so the reduced-motion floor reaches this like everything
          // else and leaves a static, legible label.
          <span className="agent-shimmer shrink-0 text-[11px] font-medium" data-insight-live="">
            {liveLabel}
          </span>
        ) : null}
      </div>

      <p className="mt-1 flex items-baseline gap-1">
        {unavailable ? (
          <span data-insight-value="unavailable" className="text-xl font-semibold text-muted-foreground">
            <span aria-hidden="true">{INSIGHT_UNAVAILABLE_GLYPH}</span>
            <span className="sr-only">{INSIGHT_UNAVAILABLE_LABEL}</span>
          </span>
        ) : (
          <>
            {/* `tabular-nums`: a deck of cards whose digits change width jitters
                on every refresh, which reads as the layout being unsure. */}
            <span className="text-xl font-semibold tabular-nums text-foreground">{shown}</span>
            {unit ? <span className="text-[11px] text-muted-foreground">{unit}</span> : null}
          </>
        )}
      </p>

      {delta ? (
        <p data-insight-delta={delta.direction} className={`mt-0.5 text-[11px] font-medium ${TONE_CLASS[tone]}`}>
          <span aria-hidden="true">{DIRECTION_GLYPH[delta.direction]} </span>
          {formatInsightDelta(delta, format)}
        </p>
      ) : null}

      {description ? <p className="mt-1 text-[11px] text-muted-foreground">{description}</p> : null}

      {series ? (
        <div className="mt-2 text-muted-foreground">
          {/* Muted, not the accent: one accent colour at rest belongs on the
              next action, and a meaningful graphic still needs to clear 3:1 —
              which the text-grade muted foreground does and a divider tint
              does not. */}
          <Sparkline values={series} label={seriesLabel ?? title} format={format} />
        </div>
      ) : null}

      {action ? <div className="mt-3">{renderInsightAction(action)}</div> : null}
    </article>
  )
}

function renderInsightAction(action: InsightAction | ReactElement): ReactNode {
  if (isValidElement(action)) return action
  return (
    <button
      type="button"
      onClick={action.onClick}
      className="h-8 rounded-md border border-border px-3 text-xs font-medium text-foreground transition hover:bg-accent"
    >
      {action.label}
    </button>
  )
}

// ── the deck ──────────────────────────────────────────────────────────────

export interface Insight extends InsightCardProps {
  /** Stable across refreshes: it keys the card, and a key that moves replays
   *  the arrival on every poll. */
  readonly id: string
}

export const DEFAULT_INSIGHT_PAGE_SIZE = 3
/** Past this many pages the dots stop being scannable and become a second row
 *  of controls; the counter and the arrows carry it from there. */
const MAX_PAGE_DOTS = 8

const warnedPageSizes = new Set<number>()

/**
 * The page size — ONE definition, read by the count and by the slice.
 *
 * Two definitions is how a deck hides an insight with no error at all: a count
 * that divides by the raw `2.5` claims two pages of a five-card deck, a slice
 * that floors it puts two cards on each, and the fifth card is on no page the
 * reader can reach. Nothing renders wrong; a card is simply gone.
 *
 * A page size is a count of cards, so a fraction, a zero and a negative are not
 * smaller decks — they are caller mistakes, and this normalises them back to the
 * default and says so once per offending value. Normalised rather than thrown
 * because the value is often computed from a measured viewport, where the first
 * paint legitimately produces a `0`: a deck that pages in threes is a far
 * smaller failure than a dashboard that throws during render.
 */
export function insightPageSize(pageSize: number = DEFAULT_INSIGHT_PAGE_SIZE): number {
  if (Number.isInteger(pageSize) && pageSize >= 1) return pageSize
  // Once per distinct value: this runs on every render of every deck, and a
  // warning repeated sixty times a second is one nobody reads.
  if (!warnedPageSizes.has(pageSize)) {
    warnedPageSizes.add(pageSize)
    console.warn(
      `[insight-card] pageSize must be a whole number of cards, 1 or more — received ${String(pageSize)}. ` +
        `Using ${DEFAULT_INSIGHT_PAGE_SIZE}. A fractional page size hides cards on no page at all.`,
    )
  }
  return DEFAULT_INSIGHT_PAGE_SIZE
}

/** Always at least one page, so "Page 1 of 0" cannot be rendered. */
export function insightPageCount(total: number, pageSize: number = DEFAULT_INSIGHT_PAGE_SIZE): number {
  const size = insightPageSize(pageSize)
  // `total` reaches this as an array length from every caller in the package;
  // the clamp is for the exported surface, where "Page 1 of NaN" is the same
  // class of defect as the figure that renders one.
  const counted = Number.isFinite(total) && total > 0 ? total : 0
  return Math.max(1, Math.ceil(counted / size))
}

/** The items on `page`, with the page clamped into range — a deck whose list
 *  shrank under the reader shows the last page that exists, never a blank one. */
export function insightPageSlice<T>(items: readonly T[], page: number, pageSize: number = DEFAULT_INSIGHT_PAGE_SIZE): readonly T[] {
  const size = insightPageSize(pageSize)
  const count = insightPageCount(items.length, size)
  const requested = Number.isFinite(page) ? Math.floor(page) : 0
  const safe = Math.min(Math.max(requested, 0), count - 1)
  return items.slice(safe * size, safe * size + size)
}

/** `--stagger-index` as a typed style, so the arrival delay is a token
 *  calculation in CSS rather than a duration written in TypeScript. */
type StaggerStyle = CSSProperties & Record<'--stagger-index', number>

function staggerStyle(index: number, base?: CSSProperties): StaggerStyle {
  return { ...base, '--stagger-index': index }
}

export interface InsightDeckProps {
  /** The same five-state contract every other screen fetches through. */
  state: AsyncResourceState<readonly Insight[]>
  /** Required by `AsyncView`: an empty deck must say what is missing and what
   *  to do about it. */
  empty: AsyncEmptySpec | ReactElement
  /** Names the region for assistive tech and titles nothing visually — the
   *  cards carry their own headings. */
  label?: string
  pageSize?: number
  loadingLabel?: string
  retryLabel?: string
  className?: string
  onPageChange?: (page: number) => void
}

/**
 * The paged deck.
 *
 * `AsyncView` owns the non-`ready` branches, which is what makes the invariant
 * structural here: this component has no branch of its own that could render
 * the empty copy over a failure, because it never sees a state that is not
 * `ready`.
 *
 * The page number is held HERE, above that boundary, and not inside the
 * component that renders the cards. A refresh re-enters `loading`, `AsyncView`
 * swaps the ready subtree for the busy block, and every piece of state inside it
 * is destroyed — so a poll the reader did not ask for would throw them back to
 * page 1 mid-read. Above the boundary it survives the round trip.
 */
export function InsightDeck({
  state,
  empty,
  label = 'Insights',
  pageSize = DEFAULT_INSIGHT_PAGE_SIZE,
  loadingLabel = 'Loading insights…',
  retryLabel,
  className,
  onPageChange,
}: InsightDeckProps): ReactElement {
  const [page, setPage] = useState(0)
  const selectPage = useCallback(
    (next: number) => {
      setPage(next)
      onPageChange?.(next)
    },
    [onPageChange],
  )

  return (
    <AsyncView
      state={state}
      empty={empty}
      loadingLabel={loadingLabel}
      retryLabel={retryLabel}
      // The same box in every state: a deck that is 200px tall while loading
      // and 400px once loaded shoves the page under it on arrival.
      className={className}
    >
      {(insights) => (
        <InsightPages
          insights={insights}
          label={label}
          pageSize={pageSize}
          className={className}
          page={page}
          onSelectPage={selectPage}
        />
      )}
    </AsyncView>
  )
}

function InsightPages({
  insights,
  label,
  pageSize,
  className,
  page,
  onSelectPage,
}: {
  insights: readonly Insight[]
  label: string
  pageSize: number
  className?: string
  page: number
  onSelectPage: (page: number) => void
}): ReactElement {
  const size = insightPageSize(pageSize)
  const pageCount = insightPageCount(insights.length, size)
  // Clamped at render, not only on navigation: the list can shrink between
  // renders (a retry returning fewer insights) and held state would point past
  // the end. Clamped rather than written back, so a list that grows again
  // returns the reader to where they were.
  const current = Math.min(Math.max(page, 0), pageCount - 1)
  const visible = insightPageSlice(insights, current, size)

  /** `true` when the page actually moved — which is what decides whether the
   *  key that asked for it is consumed. */
  const goTo = useCallback(
    (next: number): boolean => {
      const clamped = Math.min(Math.max(next, 0), pageCount - 1)
      if (clamped === current) return false
      onSelectPage(clamped)
      return true
    },
    [current, onSelectPage, pageCount],
  )

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented) return
    const target = event.target as HTMLElement | null
    // A card's action may be a text field or a select; arrow keys belong to
    // those before they belong to paging.
    if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return
    let moved = false
    switch (event.key) {
      case 'ArrowRight':
      case 'PageDown':
        moved = goTo(current + 1)
        break
      case 'ArrowLeft':
      case 'PageUp':
        moved = goTo(current - 1)
        break
      case 'Home':
        moved = goTo(0)
        break
      case 'End':
        moved = goTo(pageCount - 1)
        break
      default:
        return
    }
    // Only a key that turned a page is consumed. `ArrowRight` on the last page
    // moves nothing here, and swallowing it there costs the reader the scroll
    // the browser would have done — a surface taking a key it has no use for.
    if (moved) event.preventDefault()
  }

  return (
    <section
      aria-label={label}
      data-insight-deck=""
      className={joinClasses('space-y-3', className)}
      onKeyDown={onKeyDown}
      // The deck itself is the paging control, so it has to be somewhere a
      // keyboard can land: a handler on an element with no tab stop is reachable
      // only by a mouse user, who has the arrows anyway. One stop, and only when
      // there is a second page to reach — a single-page deck offers nothing to
      // page to and should not be in anyone's tab order.
      tabIndex={pageCount > 1 ? 0 : undefined}
      aria-keyshortcuts={pageCount > 1 ? 'ArrowLeft ArrowRight PageUp PageDown Home End' : undefined}
    >
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map(({ id, style, ...card }, index) => (
          // The page index is in the key on purpose: a page turn is an arrival,
          // and reusing the node would swap the text under a card that never
          // moved. Remounting replays `.agent-arrive` with the new stagger.
          <li key={`${current}:${id}`}>
            <InsightCard {...card} style={staggerStyle(index, style)} />
          </li>
        ))}
      </ul>

      {pageCount > 1 ? (
        <div className="flex items-center justify-between gap-2">
          <p role="status" aria-live="polite" className="text-[11px] text-muted-foreground">
            Page {current + 1} of {pageCount}
          </p>
          <div className="flex items-center gap-1">
            <PagerButton label="Previous insights" glyph="‹" atEnd={current === 0} onClick={() => goTo(current - 1)} />
            {pageCount <= MAX_PAGE_DOTS
              ? Array.from({ length: pageCount }, (_, index) => (
                  // WCAG 2.2 SC 2.5.8 wants a 24x24 CSS px target. The dot stays
                  // 8px because a 24px dot is a different control; the BUTTON
                  // around it carries the target, so the padding is the hit area
                  // and the span is the graphic. The Spacing exception cannot
                  // rescue the bare dot — at a 12px pitch the 24px circle around
                  // each centre overlaps its neighbour's.
                  <button
                    key={index}
                    type="button"
                    aria-label={`Page ${index + 1} of ${pageCount}`}
                    // `page`, not `true`: `true` is the generic token, and
                    // `page` is the one ARIA defines for a pagination control.
                    aria-current={index === current ? 'page' : undefined}
                    onClick={() => goTo(index)}
                    className="group flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
                  >
                    {/* The hover now belongs to the target, not to the graphic:
                        `group-hover` keeps the whole 24px square reactive
                        instead of only the 8px the eye is aiming at. */}
                    <span
                      aria-hidden="true"
                      className={`block h-2 w-2 rounded-full transition ${
                        index === current ? 'bg-foreground' : 'bg-border group-hover:bg-muted-foreground'
                      }`}
                    />
                  </button>
                ))
              : null}
            <PagerButton
              label="Next insights"
              glyph="›"
              atEnd={current === pageCount - 1}
              onClick={() => goTo(current + 1)}
            />
          </div>
        </div>
      ) : null}
    </section>
  )
}

/**
 * `aria-disabled`, never the `disabled` attribute.
 *
 * A disabled button leaves the tab order at the moment it is pressed, so the
 * keyboard user who paged to the last card loses the focus they were paging
 * with and lands on the document body. Keeping it focusable and inert holds the
 * focus where the reader put it, and the arrow keys keep working from there.
 */
function PagerButton({
  label,
  glyph,
  atEnd,
  onClick,
}: {
  label: string
  glyph: string
  atEnd: boolean
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={atEnd}
      onClick={() => {
        if (!atEnd) onClick()
      }}
      className={`flex h-6 w-6 items-center justify-center rounded-md border border-border text-xs text-muted-foreground transition ${
        atEnd ? 'opacity-40' : 'hover:bg-accent hover:text-foreground'
      }`}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  )
}
