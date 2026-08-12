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
 * from the deck, and a page TURN remounts them so the next page arrives as a
 * sequence instead of swapping text under cards that never moved. A REFRESH is
 * the opposite case and gets the opposite treatment — see the deck's own note.
 * Every piece of that is decoration, carries no `data-motion`, and collapses
 * under `prefers-reduced-motion` — the live label included.
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
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react'

import { AsyncView, type AsyncEmptySpec, type AsyncResourceState } from './async'
import { joinClasses } from './class-names'
import { staggerStyle } from './motion'
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
  /** Stable across refreshes: it keys the card. Paired with the deck holding
   *  the last loaded page across a reload, a stable id is what lets a settled
   *  card keep its own DOM node — and therefore not replay its arrival — when
   *  a poll returns the same insight. */
  readonly id: string
}

export const DEFAULT_INSIGHT_PAGE_SIZE = 3
/** Past this many pages the dots stop being scannable and become a second row
 *  of controls; the counter and the arrows carry it from there. */
const MAX_PAGE_DOTS = 8

/**
 * What is wrong with a page size — and the key the warning dedupes on.
 *
 * Dedupe by VALUE alone is the leak: the size is often computed from a measured
 * viewport, a drag-resize produces a new fractional value on every frame, and a
 * `Set<number>` that never forgets then grows once per frame while the console
 * fills with the same sentence about a different decimal. Measured: 500 distinct
 * fractional sizes, 499 retained entries, 499 lines.
 *
 * The fault is the useful unit — a caller who passed `2.5` has one mistake to
 * fix, not five hundred — so the cache is a fixed three buckets, each of which
 * names the first {@link MAX_NAMED_PAGE_SIZES} distinct values it sees and then
 * latches shut and drops what it was holding.
 */
type PageSizeFault = 'not-a-number' | 'below-one' | 'fractional'

const PAGE_SIZE_FAULT_REASON: Record<PageSizeFault, string> = {
  'not-a-number': 'A page size that is not a number cannot count cards at all.',
  'below-one': 'A page size below one card gives the deck a page nothing fits on.',
  fractional: 'A fractional page size hides cards on no page at all.',
}

/** Distinct offending values each fault names before it goes quiet. Naming the
 *  first few is the developer aid; naming the five-hundredth is noise sitting on
 *  top of a leak. */
const MAX_NAMED_PAGE_SIZES = 8

const warnedPageSizes: Record<PageSizeFault, { readonly named: Set<number>; latched: boolean }> = {
  'not-a-number': { named: new Set<number>(), latched: false },
  'below-one': { named: new Set<number>(), latched: false },
  fractional: { named: new Set<number>(), latched: false },
}

function pageSizeFault(pageSize: number): PageSizeFault {
  if (!Number.isFinite(pageSize)) return 'not-a-number'
  if (pageSize < 1) return 'below-one'
  return 'fractional'
}

function warnPageSize(pageSize: number): void {
  const fault = pageSizeFault(pageSize)
  const record = warnedPageSizes[fault]
  // Once per distinct value, and only while the bucket is still naming values:
  // this runs on every render of every deck, and a warning repeated sixty times
  // a second is one nobody reads.
  if (record.latched || record.named.has(pageSize)) return
  record.named.add(pageSize)
  console.warn(
    `[insight-card] pageSize must be a whole number of cards, 1 or more — received ${String(pageSize)}. ` +
      `Using ${DEFAULT_INSIGHT_PAGE_SIZE}. ${PAGE_SIZE_FAULT_REASON[fault]}`,
  )
  if (record.named.size >= MAX_NAMED_PAGE_SIZES) {
    // Nothing more will be printed for this fault, so the values it was keeping
    // in order to dedupe are dead weight — the bucket ends holding nothing.
    record.named.clear()
    record.latched = true
    console.warn(`[insight-card] further "${fault}" pageSize warnings are suppressed.`)
  }
}

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
  warnPageSize(pageSize)
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
  /**
   * The page the reader is ON, whatever moved them there.
   *
   * That includes the render-time clamp: a list that shrinks under a reader
   * standing on page 3 leaves them on the last page that exists, and a parent
   * persisting this to a URL or to storage would otherwise keep writing a page
   * number nothing can reach. Reported once per effective page, never twice for
   * the same one.
   */
  onPageChange?: (page: number) => void
}

/**
 * The paged deck.
 *
 * `AsyncView` owns the non-`ready` branches, which is what makes the invariant
 * structural here: the cards are rendered from one branch of that component,
 * and no branch of this one could paint the empty copy over a failure.
 *
 * **A REFRESH DOES NOT REPLACE WHAT IS ON SCREEN.** `useAsyncResource` re-enters
 * `loading` with no value held on every reload, and handing that straight to
 * `AsyncView` swaps the ready subtree for the busy block — which destroys the
 * DOM the reader is standing in. Measured, on a real reload: `document.
 * activeElement` fell to `document.body`, so a keyboard reader mid-page lost
 * their place on every automatic poll; and every settled card was a NEW node, so
 * `.agent-arrive` replayed across the whole visible page — the exact flash this
 * surface's motion rules exist to prevent. Holding the page NUMBER above the
 * boundary fixed the counter and none of that, because the subtree under it was
 * still being torn down.
 *
 * So the deck holds the last insights it rendered and keeps handing them to the
 * SAME `AsyncView` branch while a reload is in flight: same element, same
 * position, same keys — React reuses the nodes, focus stays where the reader put
 * it, and nothing re-animates. `aria-busy` on the region is the signal that a
 * load is in flight; a per-card one is `live` on the card.
 *
 * The bridge is only ever over a WAIT. `error` and `empty` are answers about the
 * resource, so they drop what was held and render their own branch — a failed
 * fetch still cannot paint stale numbers, and the async module's invariant is
 * untouched.
 *
 * It bridges one resource, not one component: if the SUBJECT changes (a
 * different workspace, a different window), give the deck a `key` so it remounts
 * rather than showing the previous subject's numbers while the new ones load.
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
  const [held, setHeld] = useState<readonly Insight[] | null>(null)

  // Adjusted during render, which is what keeps the swap out of the DOM: an
  // effect runs after the commit, so the teardown this exists to prevent would
  // already have happened by the time it fired.
  const answered = state.status === 'error' || state.status === 'empty'
  const carried = state.status === 'ready' ? state.value : answered ? null : held
  if (carried !== held) setHeld(carried)

  const shown: AsyncResourceState<readonly Insight[]> =
    carried !== null && state.status !== 'ready' ? { status: 'ready', value: carried, retry: state.retry } : state
  const refreshing = shown !== state

  // The last page reported to the caller. A clamp and a navigation both settle
  // on an effective page, and the caller hears about each one exactly once.
  const reported = useRef(0)
  const settlePage = useCallback(
    (next: number) => {
      if (reported.current === next) return
      reported.current = next
      onPageChange?.(next)
    },
    [onPageChange],
  )

  return (
    <AsyncView
      state={shown}
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
          busy={refreshing}
          onSelectPage={setPage}
          onPageSettled={settlePage}
        />
      )}
    </AsyncView>
  )
}

/** Tag names whose own keyboard model owns the arrow keys. */
const EDITABLE_TAG = /^(INPUT|TEXTAREA|SELECT)$/

/**
 * ARIA roles that own the arrow keys, checked because the TAG name cannot
 * answer the question.
 *
 * `action` takes an arbitrary element, so a card's next action is routinely a
 * composed widget: a combobox is a `<button aria-expanded>` far more often than
 * it is a `<select>`, a slider is a `<div role="slider">`, a menu button opens a
 * `role="menu"`. Measured on the documented object form: `<button
 * role="combobox">` inside a card had its `ArrowRight` swallowed by the deck,
 * which then paged away from the control the reader was operating.
 *
 * Walked up to the deck rather than read off the event target, because focus
 * inside a composite widget lands on a descendant — the `role="grid"` is the
 * ancestor of the `role="gridcell"` that has focus.
 */
const ARROW_KEY_ROLES: ReadonlySet<string> = new Set([
  'application',
  'combobox',
  'grid',
  'gridcell',
  'listbox',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radiogroup',
  'row',
  'scrollbar',
  'searchbox',
  'slider',
  'spinbutton',
  'tab',
  'tablist',
  'textbox',
  'tree',
  'treegrid',
  'treeitem',
])

function ownsArrowKeys(target: EventTarget | null, boundary: EventTarget | null): boolean {
  let node = target instanceof Element ? target : null
  while (node !== null && node !== boundary) {
    if (EDITABLE_TAG.test(node.tagName)) return true
    if (node instanceof HTMLElement && node.isContentEditable) return true
    const role = node.getAttribute('role')
    if (role !== null && role.split(/\s+/).some((token) => ARROW_KEY_ROLES.has(token))) return true
    node = node.parentElement
  }
  return false
}

function InsightPages({
  insights,
  label,
  pageSize,
  className,
  page,
  busy,
  onSelectPage,
  onPageSettled,
}: {
  insights: readonly Insight[]
  label: string
  pageSize: number
  className?: string
  page: number
  busy: boolean
  onSelectPage: (page: number) => void
  onPageSettled: (page: number) => void
}): ReactElement {
  const size = insightPageSize(pageSize)
  const pageCount = insightPageCount(insights.length, size)
  // Clamped at render, not only on navigation: the list can shrink between
  // renders (a retry returning fewer insights) and held state would point past
  // the end. Clamped rather than written back, so a list that grows again
  // returns the reader to where they were — and the caller is TOLD which page
  // that leaves them on, through `onPageSettled` below.
  const current = Math.min(Math.max(page, 0), pageCount - 1)
  const visible = insightPageSlice(insights, current, size)

  const sectionRef = useRef<HTMLElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  /** Set by a page turn that was made from INSIDE the cards, which the turn is
   *  about to replace. */
  const recoverFocus = useRef(false)

  // One report per effective page, from either cause. Held above this component
  // so a remount cannot re-report a page the caller already has.
  useEffect(() => {
    onPageSettled(current)
  }, [current, onPageSettled])

  // Where focus goes on a page turn, decided rather than dropped.
  //
  // A page turn deliberately REMOUNTS the cards (the page-prefixed key — that is
  // what replays the arrival), so a reader standing on a card's action is
  // standing on a node that is about to be removed: measured, `document.
  // activeElement` became `document.body`. The deck is the answer. It owns the
  // paging, it survives the turn, it is a tab stop whenever there is a page to
  // turn to, and every paging key works from it — so the reader keeps paging
  // instead of being returned to the top of the document.
  //
  // A turn made from a PAGER control moves nothing: those buttons outlive the
  // turn, and taking focus off the "Next insights" the reader is clicking would
  // be the same defect pointed the other way.
  useEffect(() => {
    if (!recoverFocus.current) return
    recoverFocus.current = false
    sectionRef.current?.focus()
  }, [current])

  /** `true` when the page actually moved — which is what decides whether the
   *  key that asked for it is consumed. */
  const goTo = useCallback(
    (next: number): boolean => {
      const clamped = Math.min(Math.max(next, 0), pageCount - 1)
      if (clamped === current) return false
      const active = typeof document === 'undefined' ? null : document.activeElement
      recoverFocus.current = active instanceof Node && (listRef.current?.contains(active) ?? false)
      onSelectPage(clamped)
      return true
    },
    [current, onSelectPage, pageCount],
  )

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented) return
    // A card's action may be a text field, a select, or any ARIA widget whose
    // own keyboard model owns the arrows; they belong to it before they belong
    // to paging.
    if (ownsArrowKeys(event.target, event.currentTarget)) return
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
      ref={sectionRef}
      aria-label={label}
      data-insight-deck=""
      // Emitted in both states rather than added when the reload starts: a
      // region that only gains the attribute while busy gives assistive tech no
      // transition to report. The deck keeps its cards through the reload, so
      // this is the only thing that says one is happening.
      aria-busy={busy}
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
      <ul ref={listRef} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map(({ id, style, ...card }, index) => (
          // The page index is in the key on purpose: a page turn is an arrival,
          // and reusing the node would swap the text under a card that never
          // moved. Remounting replays `.agent-arrive` with the new stagger.
          //
          // A REFRESH is the other case and the key is why it behaves the other
          // way: the page has not changed and the id is stable, so the key
          // matches, React keeps the node, and a card that was already settled
          // does not arrive a second time. The key does BOTH jobs — but only
          // because the deck now keeps this subtree mounted across a reload
          // (see `InsightDeck`); a key is never compared across a teardown.
          <li key={`${current}:${id}`}>
            <InsightCard {...card} style={staggerStyle(index, style)} />
          </li>
        ))}
      </ul>

      {/* The live region is mounted whatever shape the deck is in. Held inside
          the `pageCount > 1` branch it was DESTROYED the moment a shrinking list
          collapsed the deck onto one page — measured: a reader on page 3 of 3
          watched the list drop to two insights, the counter unmounted with the
          pager, and the one change most worth announcing was the change that
          removed the thing that would have announced it. Mounted, its text goes
          from "Page 3 of 3" to "Page 1 of 1" and the reader is told. */}
      <div className={pageCount > 1 ? 'flex items-center justify-between gap-2' : undefined}>
        <p
          role="status"
          aria-live="polite"
          className={pageCount > 1 ? 'text-[11px] text-muted-foreground' : 'sr-only'}
        >
          Page {current + 1} of {pageCount}
        </p>
        {pageCount > 1 ? (
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
                    {/* `bg-muted-foreground`, NOT `bg-border`. A divider token is
                        tuned to be barely there, and measured in Chromium the
                        inactive dot painted rgb(204,205,211) on rgb(236,236,241)
                        — 1.35:1, less than half the 3:1 WCAG 2.2 SC 1.4.11 asks
                        of a meaningful graphic. This card's own sparkline note
                        already says the text-grade muted foreground clears that
                        bar and a divider tint does not; the dots are the same
                        kind of graphic and now use the same token.

                        The CURRENT page then needs a second channel, because
                        tone alone no longer carries it: foreground against
                        muted-foreground is 3.10:1 in light but 2.27:1 in dark.
                        So the current page is a WIDER bar at the same 8px
                        height — a difference in shape, which survives both a
                        low-contrast theme and forced colours, and still sits
                        inside the 24px target with the pitch unchanged.

                        The hover belongs to the target, not to the graphic:
                        `group-hover` keeps the whole 24px square reactive
                        instead of only the 8px the eye is aiming at. */}
                    <span
                      aria-hidden="true"
                      className={joinClasses(
                        'block rounded-full transition',
                        index === current ? 'h-2 w-4 bg-foreground' : 'h-2 w-2 bg-muted-foreground group-hover:bg-foreground',
                      )}
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
        ) : null}
      </div>
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
