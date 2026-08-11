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

import type { ReactElement } from 'react'

import { joinClasses } from './class-names'

/** Where a series ended relative to where it started. */
export type SparklineDirection = 'rising' | 'falling' | 'flat'

export interface SparklinePoint {
  readonly x: number
  readonly y: number
}

export interface SparklineGeometry {
  /** The finite readings, in order — what was actually plotted. */
  readonly readings: readonly number[]
  readonly points: readonly SparklinePoint[]
  readonly min: number
  readonly max: number
  readonly first: number
  readonly last: number
  readonly direction: SparklineDirection
}

export interface SparklineGeometryOptions {
  width?: number
  height?: number
  /** Keeps the stroke and the end dot inside the viewBox instead of clipping
   *  them at the extremes, where the interesting readings always are. */
  inset?: number
}

export const DEFAULT_SPARKLINE_WIDTH = 96
export const DEFAULT_SPARKLINE_HEIGHT = 24
const DEFAULT_INSET = 2.5
const STROKE_WIDTH = 1.5
const DOT_RADIUS = 1.75
/** Only a name, never a metric: it exists so the accessible label is never
 *  empty. Every caller in this package passes the metric's own title. */
export const DEFAULT_SPARKLINE_LABEL = 'Trend'
export const DEFAULT_SPARKLINE_EMPTY_LABEL = 'No history yet'

const NUMBER_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

/** The package's default number rendering, pinned to `en-US` so a card and its
 *  series read the same on every host — a series formatted by the server's
 *  locale and a value formatted by the browser's is a defect nobody sees until
 *  the decimal separators disagree. */
export function formatSparklineValue(value: number): string {
  return NUMBER_FORMAT.format(value)
}

/**
 * The readings that can be plotted.
 *
 * A `null` from a gap in a series, or a `NaN` from a division a producer did
 * not guard, is dropped rather than coerced to `0`: plotting a missing reading
 * at the baseline draws a cliff that never happened, which is a worse lie than
 * the shorter series.
 */
export function sparklineReadings(values: readonly number[]): number[] {
  return values.filter((value) => typeof value === 'number' && Number.isFinite(value))
}

/** Two decimals: enough for a 96px glyph, and it keeps the serialised `points`
 *  attribute stable enough to assert on. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Plots the series into the viewBox.
 *
 * Pure and exported so the cases that produce a broken chart — nothing, one
 * reading, a flat series, negatives — are unit-testable without a DOM.
 */
export function sparklineGeometry(
  values: readonly number[],
  { width = DEFAULT_SPARKLINE_WIDTH, height = DEFAULT_SPARKLINE_HEIGHT, inset = DEFAULT_INSET }: SparklineGeometryOptions = {},
): SparklineGeometry {
  const readings = sparklineReadings(values)
  if (readings.length === 0) {
    return { readings, points: [], min: 0, max: 0, first: 0, last: 0, direction: 'flat' }
  }

  // Folded rather than `Math.min(...readings)`: a spread of a long series
  // overflows the argument limit, and a spend chart is exactly the caller that
  // hands over a year of daily readings.
  let min = readings[0] as number
  let max = readings[0] as number
  for (const value of readings) {
    if (value < min) min = value
    if (value > max) max = value
  }

  const first = readings[0] as number
  const last = readings[readings.length - 1] as number
  const span = max - min
  const top = inset
  const bottom = height - inset
  const left = inset
  const right = width - inset

  const points = readings.map((value, index) => ({
    // A single reading sits in the middle rather than at the left edge, where
    // it reads as the start of a line whose rest failed to render.
    x: round(readings.length === 1 ? width / 2 : left + ((right - left) * index) / (readings.length - 1)),
    // `span === 0` is the stable metric. Mid-height is the honest render of it;
    // dividing by the span here is the NaN that erases the whole polyline.
    y: round(span === 0 ? height / 2 : bottom - ((bottom - top) * (value - min)) / span),
  }))

  return {
    readings,
    points,
    min,
    max,
    first,
    last,
    direction: last > first ? 'rising' : last < first ? 'falling' : 'flat',
  }
}

/** `"2,14 48,3 94,21"` — the `points` attribute of the polyline. */
export function sparklinePointsAttribute(points: readonly SparklinePoint[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(' ')
}

export interface SparklineLabelOptions {
  label?: string
  format?: (value: number) => string
}

/**
 * The accessible name: metric, how many readings, the range, and the direction.
 *
 * Both halves are load-bearing. The range without the direction describes a
 * shape that could have been walked in either order; the direction without the
 * range says "rising" about a metric that moved by a rounding error.
 */
export function sparklineLabel(
  values: readonly number[],
  { label = DEFAULT_SPARKLINE_LABEL, format = formatSparklineValue }: SparklineLabelOptions = {},
): string {
  const { readings, min, max, first, last, direction } = sparklineGeometry(values)
  if (readings.length === 0) return `${label}: no readings yet`
  if (readings.length === 1) return `${label}: one reading, ${format(first)}`
  if (max === min) return `${label}: ${readings.length} readings, unchanged at ${format(first)}`
  // A series can cover ground and come back — the range is real, the net move
  // is not, and "flat" alone would hide the first while "rising" would invent
  // the second.
  const movement = direction === 'flat' ? 'net unchanged' : direction
  return (
    `${label}: ${readings.length} readings, range ${format(min)} to ${format(max)}, ` +
    `${movement} from ${format(first)} to ${format(last)}`
  )
}

export interface SparklineProps {
  values: readonly number[]
  /** Names the metric in the accessible label. */
  label?: string
  /** Renders a reading in that label; defaults to the package number format. */
  format?: (value: number) => string
  width?: number
  height?: number
  /** Shown instead of a line when there is nothing to plot. */
  emptyLabel?: string
  className?: string
}

/** The series glyph. Strokes in `currentColor`, so tone is the caller's. */
export function Sparkline({
  values,
  label = DEFAULT_SPARKLINE_LABEL,
  format = formatSparklineValue,
  width = DEFAULT_SPARKLINE_WIDTH,
  height = DEFAULT_SPARKLINE_HEIGHT,
  emptyLabel = DEFAULT_SPARKLINE_EMPTY_LABEL,
  className,
}: SparklineProps): ReactElement {
  const geometry = sparklineGeometry(values, { width, height })
  const accessibleName = sparklineLabel(values, { label, format })

  if (geometry.points.length === 0) {
    // Words, not a flat line at zero. The metric name stays in the reading
    // order for assistive tech, where "No history yet" on its own would be one
    // of several unattributed phrases on a deck of cards.
    return (
      <span data-sparkline="empty" className={joinClasses('text-[11px] text-muted-foreground', className)}>
        <span className="sr-only">{label}: </span>
        {emptyLabel}
      </span>
    )
  }

  const isPoint = geometry.points.length === 1
  const end = geometry.points[geometry.points.length - 1] as SparklinePoint

  return (
    <svg
      role="img"
      aria-label={accessibleName}
      data-sparkline={isPoint ? 'point' : 'line'}
      data-direction={geometry.direction}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      // A decorative-by-default `focusable` keeps IE-era SVG out of the tab
      // order; the label is what carries this element, not focus.
      focusable="false"
    >
      {isPoint ? null : (
        <polyline
          points={sparklinePointsAttribute(geometry.points)}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {/* The latest reading, marked. Without it the eye has to decide which end
          of the line is "now", and half the readers guess wrong. */}
      <circle cx={end.x} cy={end.y} r={DOT_RADIUS} fill="currentColor" />
    </svg>
  )
}
