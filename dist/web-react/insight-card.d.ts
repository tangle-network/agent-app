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
import { type CSSProperties, type ReactElement } from 'react';
import { type AsyncEmptySpec, type AsyncResourceState } from './async';
export type InsightDirection = 'up' | 'down' | 'flat';
/** Which way is good news for THIS metric. `neutral` is the default because it
 *  is the only answer that is true for every metric. */
export type InsightPolarity = 'higher-is-better' | 'lower-is-better' | 'neutral';
export type InsightTone = 'positive' | 'negative' | 'neutral';
export interface InsightDelta {
    /** The baseline the move is measured against — rendered, so the delta is
     *  never a number floating free of what produced it. */
    readonly previous: number;
    readonly absolute: number;
    /** `null` when the baseline is `0`: a share of nothing is undefined, and
     *  "+∞%" or a silently-dropped percentage are both worse than the absolute. */
    readonly percent: number | null;
    readonly direction: InsightDirection;
}
/**
 * The move, or `null` when there is no honest one to state.
 *
 * `unknown` inputs on purpose: these arrive from a fetched payload, and the
 * cases that must not produce a delta — a missing baseline, a `null` from a
 * first-ever reading, a `NaN` from a producer's division — are exactly the ones
 * a narrower signature would let through as `0`.
 */
export declare function insightDelta(value: unknown, previous: unknown): InsightDelta | null;
/** Maps a direction onto good/bad news, which only the caller knows. */
export declare function insightDeltaTone(direction: InsightDirection, polarity?: InsightPolarity): InsightTone;
/**
 * The delta as words: direction, magnitude, and the baseline it is measured
 * against. Words rather than an arrow plus a bare number, because the arrow is
 * `aria-hidden` and a reader hearing "12%" learns nothing about which way.
 */
export declare function formatInsightDelta(delta: InsightDelta, format?: (value: number) => string): string;
export interface InsightAction {
    label: string;
    onClick: () => void;
}
export interface InsightCardProps {
    /** The lane the metric belongs to ("Spend", "Missions"), set small above the
     *  title. A deck of cards from different surfaces needs the grouping word
     *  before the metric's own name, not after it. */
    eyebrow?: string;
    /** What was measured, in the reader's words ("Spend today"). */
    title: string;
    /** The number that moved. A `string` renders verbatim — a total the caller
     *  already formatted with its own currency — and takes no delta, because
     *  there is nothing to subtract. A non-finite number is not a measurement and
     *  renders as {@link INSIGHT_UNAVAILABLE_GLYPH}, never as "NaN" or "∞". */
    value: number | string;
    /** "USD", "runs", "%" — the unit the number is in, beside it rather than
     *  glued into it, so the figure stays scannable. */
    unit?: string;
    /** The baseline. Absent ⇒ the card renders the value and no delta. */
    previous?: number;
    polarity?: InsightPolarity;
    /** One number format for the value, the delta and the series, so the three
     *  cannot disagree about decimals on the same card. */
    format?: (value: number) => string;
    series?: readonly number[];
    /** Names the series in its accessible label; defaults to the card's title. */
    seriesLabel?: string;
    /** One line of context under the number — what the window is, what is
     *  excluded. Not a restatement of the title. */
    description?: string;
    /** The next action for this insight. An element renders as supplied (a link,
     *  a dialog trigger); the object form renders the standard button. */
    action?: InsightAction | ReactElement;
    /** The number is still being computed. The label's PRESENCE is the signal, so
     *  it reads the same with motion collapsed — see the module note. */
    live?: boolean;
    liveLabel?: string;
    className?: string;
    style?: CSSProperties;
}
export declare function InsightCard({ eyebrow, title, value, unit, previous, polarity, format, series, seriesLabel, description, action, live, liveLabel, className, style, }: InsightCardProps): ReactElement;
export interface Insight extends InsightCardProps {
    /** Stable across refreshes: it keys the card. Paired with the deck holding
     *  the last loaded page across a reload, a stable id is what lets a settled
     *  card keep its own DOM node — and therefore not replay its arrival — when
     *  a poll returns the same insight. */
    readonly id: string;
}
export declare const DEFAULT_INSIGHT_PAGE_SIZE = 3;
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
export declare function insightPageSize(pageSize?: number): number;
/** Always at least one page, so "Page 1 of 0" cannot be rendered. */
export declare function insightPageCount(total: number, pageSize?: number): number;
/** The items on `page`, with the page clamped into range — a deck whose list
 *  shrank under the reader shows the last page that exists, never a blank one. */
export declare function insightPageSlice<T>(items: readonly T[], page: number, pageSize?: number): readonly T[];
export interface InsightDeckProps {
    /** The same five-state contract every other screen fetches through. */
    state: AsyncResourceState<readonly Insight[]>;
    /** Required by `AsyncView`: an empty deck must say what is missing and what
     *  to do about it. */
    empty: AsyncEmptySpec | ReactElement;
    /** Names the region for assistive tech and titles nothing visually — the
     *  cards carry their own headings. */
    label?: string;
    pageSize?: number;
    loadingLabel?: string;
    retryLabel?: string;
    className?: string;
    /**
     * The page the reader is ON, whatever moved them there.
     *
     * That includes the render-time clamp: a list that shrinks under a reader
     * standing on page 3 leaves them on the last page that exists, and a parent
     * persisting this to a URL or to storage would otherwise keep writing a page
     * number nothing can reach. Reported once per effective page, never twice for
     * the same one.
     */
    onPageChange?: (page: number) => void;
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
export declare function InsightDeck({ state, empty, label, pageSize, loadingLabel, retryLabel, className, onPageChange, }: InsightDeckProps): ReactElement;
