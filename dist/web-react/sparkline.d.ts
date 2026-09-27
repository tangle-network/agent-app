/**
 * `Sparkline` — the series behind a number, as inline SVG.
 *
 * `/spend`, `/missions` and the eval lanes all produce a number for today, and
 * every product renders it as text. Text cannot separate "$41, up from $38"
 * from "$41, up from $4" — the same sentence, two different situations — so the
 * reader opens a second surface to find out which one they are in. The series
 * next to the number answers it in one glance.
 *
 * No chart dependency: this subpath is react + `@tangle-network/ui` only, and a
 * polyline is not worth a bundle. What a chart library would give us here is
 * axes, ticks and a tooltip, none of which belong on a 96×24 glyph.
 *
 * The three shapes a hand-rolled sparkline gets wrong, each handled here rather
 * than left to the caller:
 *
 *  - **no readings** renders an explicit empty label, never a line. A line
 *    along the baseline is a claim — "this metric sat at zero" — and a series
 *    nobody has measured yet did not sit anywhere.
 *  - **one reading** renders a point. A line needs two coordinates; drawing one
 *    from a single reading invents the segment before it.
 *  - **equal readings** render flat at MID height. The obvious normalisation
 *    divides by `max - min`, which is `0` for a perfectly stable metric, and
 *    the resulting `NaN` lands in the `points` attribute — SVG drops the whole
 *    polyline, so the metric that never moved is the one that disappears.
 *  - **a missing reading renders as a GAP, and the accessible name says so.**
 *    A `null` from a hole in a series and a `NaN` from a producer's unguarded
 *    division are not smaller series — they are readings nobody has. Deleting
 *    them closed the line straight across the hole and announced a count that
 *    was short by the number deleted: measured on `[1, NaN, 3]`, one continuous
 *    two-point line labelled "2 readings, rising from 1 to 3", with nothing
 *    anywhere saying a reading was unreadable. The card's figure slot already
 *    refuses to let a non-measurement look measured; the series one line below
 *    it holds the same rule. The x axis is the SAMPLE index, so the hole keeps
 *    its width, the line breaks at it, and the label carries "N not available".
 *
 * Accessibility: `role="img"` with an `aria-label` naming the metric, its range
 * and its direction. A sparkline with no accessible name is decoration a screen
 * reader cannot report, which would leave the shape — the entire reason the
 * component exists — visible to exactly one kind of reader.
 *
 * Deliberately not animated. `docs/product-surfaces.md` Pattern 4 lists chart
 * draw-on under what this package does not animate: the shape IS the answer,
 * and easing it in taxes every read of a surface people sit in for hours. The
 * card around it arrives (`.agent-arrive`); the line does not draw itself.
 */
import type { ReactElement } from 'react';
/** Where a series ended relative to where it started. */
export type SparklineDirection = 'rising' | 'falling' | 'flat';
export interface SparklinePoint {
    readonly x: number;
    readonly y: number;
}
export interface SparklineGeometry {
    /** The finite readings, in order — what was actually plotted. */
    readonly readings: readonly number[];
    /** Every plotted point, in order. Positions are on the SAMPLE axis, so a
     *  missing reading leaves its width behind rather than closing up. */
    readonly points: readonly SparklinePoint[];
    /** The points split into runs of CONSECUTIVE samples. One run is one stroke:
     *  a line drawn across a missing reading states a movement nobody measured. */
    readonly segments: readonly (readonly SparklinePoint[])[];
    /** Samples that carried no usable reading — a `null`, a `NaN`, an infinity.
     *  Counted rather than discarded, because the accessible name has to state
     *  them: a shorter series announced as a complete one is the silent loss. */
    readonly gaps: number;
    readonly min: number;
    readonly max: number;
    readonly first: number;
    readonly last: number;
    readonly direction: SparklineDirection;
}
export interface SparklineGeometryOptions {
    width?: number;
    height?: number;
    /** Keeps the stroke and the end dot inside the viewBox instead of clipping
     *  them at the extremes, where the interesting readings always are. */
    inset?: number;
}
export declare const DEFAULT_SPARKLINE_WIDTH = 96;
export declare const DEFAULT_SPARKLINE_HEIGHT = 24;
/** Only a name, never a metric: it exists so the accessible label is never
 *  empty. Every caller in this package passes the metric's own title. */
export declare const DEFAULT_SPARKLINE_LABEL = "Trend";
export declare const DEFAULT_SPARKLINE_EMPTY_LABEL = "No history yet";
/** Nothing was measurable, which is not the same as nothing was measured yet —
 *  and "No history yet" over a series that arrived full of `NaN` reads as the
 *  metric being new when the producer is broken. */
export declare const DEFAULT_SPARKLINE_UNAVAILABLE_LABEL = "No readings available";
/** The package's default number rendering, pinned to `en-US` so a card and its
 *  series read the same on every host — a series formatted by the server's
 *  locale and a value formatted by the browser's is a defect nobody sees until
 *  the decimal separators disagree. */
export declare function formatSparklineValue(value: number): string;
/**
 * The readings that can be plotted.
 *
 * A `null` from a gap in a series, or a `NaN` from a division a producer did
 * not guard, is not plotted rather than coerced to `0`: plotting a missing
 * reading at the baseline draws a cliff that never happened.
 *
 * This returns the readings ALONE, so it cannot tell a caller how many are
 * missing. That is what {@link SparklineGeometry.gaps} is for, and what the
 * accessible name reports — dropping a sample and then announcing the shorter
 * count as the whole series is the defect, not the filter.
 */
export declare function sparklineReadings(values: readonly number[]): number[];
/**
 * Plots the series into the viewBox.
 *
 * Pure and exported so the cases that produce a broken chart — nothing, one
 * reading, a flat series, negatives — are unit-testable without a DOM.
 */
export declare function sparklineGeometry(values: readonly number[], { width, height, inset }?: SparklineGeometryOptions): SparklineGeometry;
/** `"2,14 48,3 94,21"` — the `points` attribute of the polyline. */
export declare function sparklinePointsAttribute(points: readonly SparklinePoint[]): string;
export interface SparklineLabelOptions {
    label?: string;
    format?: (value: number) => string;
}
/**
 * The accessible name: metric, how many readings, how many are missing, the
 * range, and the direction.
 *
 * All of it is load-bearing. The range without the direction describes a shape
 * that could have been walked in either order; the direction without the range
 * says "rising" about a metric that moved by a rounding error; and the count
 * without the gaps is the number of readings that SURVIVED announced as the
 * number that were taken — the shape a reader cannot see is exactly the one
 * this sentence exists to carry.
 */
export declare function sparklineLabel(values: readonly number[], { label, format }?: SparklineLabelOptions): string;
export interface SparklineProps {
    values: readonly number[];
    /** Names the metric in the accessible label. */
    label?: string;
    /** Renders a reading in that label; defaults to the package number format. */
    format?: (value: number) => string;
    width?: number;
    height?: number;
    /** Shown instead of a line when the metric has no history yet. */
    emptyLabel?: string;
    /** Shown instead of a line when every sample arrived unreadable — a different
     *  state from "no history yet", and one the reader has to be able to tell
     *  apart, because one is a new metric and the other is a broken producer. */
    unavailableLabel?: string;
    className?: string;
}
/** The series glyph. Strokes in `currentColor`, so tone is the caller's. */
export declare function Sparkline({ values, label, format, width, height, emptyLabel, unavailableLabel, className, }: SparklineProps): ReactElement;
