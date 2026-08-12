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
  /** Every plotted point, in order. Positions are on the SAMPLE axis, so a
   *  missing reading leaves its width behind rather than closing up. */
  readonly points: readonly SparklinePoint[]
  /** The points split into runs of CONSECUTIVE samples. One run is one stroke:
   *  a line drawn across a missing reading states a movement nobody measured. */
  readonly segments: readonly (readonly SparklinePoint[])[]
  /** Samples that carried no usable reading — a `null`, a `NaN`, an infinity.
   *  Counted rather than discarded, because the accessible name has to state
   *  them: a shorter series announced as a complete one is the silent loss. */
  readonly gaps: number
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
/** Nothing was measurable, which is not the same as nothing was measured yet —
 *  and "No history yet" over a series that arrived full of `NaN` reads as the
 *  metric being new when the producer is broken. */
export const DEFAULT_SPARKLINE_UNAVAILABLE_LABEL = 'No readings available'

const NUMBER_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

/** The package's default number rendering, pinned to `en-US` so a card and its
 *  series read the same on every host — a series formatted by the server's
 *  locale and a value formatted by the browser's is a defect nobody sees until
 *  the decimal separators disagree. */
export function formatSparklineValue(value: number): string {
  return NUMBER_FORMAT.format(value)
}

function isReading(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

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
export function sparklineReadings(values: readonly number[]): number[] {
  return values.filter(isReading)
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
  const samples = values.length
  // Kept WITH their sample index: the index is the x axis, so a missing reading
  // leaves a hole of the right width instead of the series closing up and
  // drawing a straight line over the sample nobody has.
  const plotted: Array<{ readonly index: number; readonly value: number }> = []
  for (let index = 0; index < samples; index += 1) {
    const value = values[index]
    if (isReading(value)) plotted.push({ index, value })
  }
  const readings = plotted.map((entry) => entry.value)
  const gaps = samples - readings.length
  if (readings.length === 0) {
    return { readings, points: [], segments: [], gaps, min: 0, max: 0, first: 0, last: 0, direction: 'flat' }
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

  const points = plotted.map(({ index, value }) => ({
    // A series of ONE SAMPLE sits in the middle rather than at the left edge,
    // where it reads as the start of a line whose rest failed to render. A
    // single reading among several samples keeps its own position — that is the
    // one thing that says where in the window the reading is.
    x: round(samples <= 1 ? width / 2 : left + ((right - left) * index) / (samples - 1)),
    // `span === 0` is the stable metric. Mid-height is the honest render of it;
    // dividing by the span here is the NaN that erases the whole polyline.
    y: round(span === 0 ? height / 2 : bottom - ((bottom - top) * (value - min)) / span),
  }))

  // One segment per run of CONSECUTIVE samples. A run break is a gap, and a
  // stroke across it would state a movement between two readings that are not
  // next to each other.
  const segments: SparklinePoint[][] = []
  let run: SparklinePoint[] = []
  let previous = Number.NEGATIVE_INFINITY
  plotted.forEach(({ index }, position) => {
    if (index !== previous + 1 && run.length > 0) {
      segments.push(run)
      run = []
    }
    run.push(points[position] as SparklinePoint)
    previous = index
  })
  if (run.length > 0) segments.push(run)

  return {
    readings,
    points,
    segments,
    gaps,
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
export function sparklineLabel(
  values: readonly number[],
  { label = DEFAULT_SPARKLINE_LABEL, format = formatSparklineValue }: SparklineLabelOptions = {},
): string {
  const { readings, gaps, min, max, first, last, direction } = sparklineGeometry(values)
  // The card's own word for a figure it does not have is "Not available"; a
  // series uses the same word rather than a second vocabulary for one fact.
  const missing = gaps === 0 ? '' : `, ${gaps} not available`
  // "no readings yet" is a claim about a NEW metric. A series that arrived and
  // was unreadable is a different state and must not borrow that sentence.
  if (readings.length === 0) return gaps === 0 ? `${label}: no readings yet` : `${label}: no readings${missing}`
  if (readings.length === 1) return `${label}: one reading${missing}, ${format(first)}`
  if (max === min) return `${label}: ${readings.length} readings${missing}, unchanged at ${format(first)}`
  // A series can cover ground and come back — the range is real, the net move
  // is not, and "flat" alone would hide the first while "rising" would invent
  // the second.
  const movement = direction === 'flat' ? 'net unchanged' : direction
  return (
    `${label}: ${readings.length} readings${missing}, range ${format(min)} to ${format(max)}, ` +
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
  /** Shown instead of a line when the metric has no history yet. */
  emptyLabel?: string
  /** Shown instead of a line when every sample arrived unreadable — a different
   *  state from "no history yet", and one the reader has to be able to tell
   *  apart, because one is a new metric and the other is a broken producer. */
  unavailableLabel?: string
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
  unavailableLabel = DEFAULT_SPARKLINE_UNAVAILABLE_LABEL,
  className,
}: SparklineProps): ReactElement {
  const geometry = sparklineGeometry(values, { width, height })
  const accessibleName = sparklineLabel(values, { label, format })

  if (geometry.points.length === 0) {
    // Words, not a flat line at zero. The sentence assistive tech gets is the
    // same one the chart would have carried, so a deck of cards never produces
    // an unattributed phrase — and a series that arrived unreadable says that,
    // rather than borrowing the copy for a metric with no history yet.
    return (
      <span
        data-sparkline={geometry.gaps > 0 ? 'unavailable' : 'empty'}
        className={joinClasses('text-[11px] text-muted-foreground', className)}
      >
        <span className="sr-only">{accessibleName}</span>
        <span aria-hidden="true">{geometry.gaps > 0 ? unavailableLabel : emptyLabel}</span>
      </span>
    )
  }

  const drawsLine = geometry.segments.some((segment) => segment.length > 1)
  const end = geometry.points[geometry.points.length - 1] as SparklinePoint

  return (
    <svg
      role="img"
      aria-label={accessibleName}
      data-sparkline={drawsLine ? 'line' : 'point'}
      data-direction={geometry.direction}
      // Readable from the DOM because "the line broke here" is not a thing a
      // caller can measure off a `points` attribute.
      data-gaps={geometry.gaps > 0 ? geometry.gaps : undefined}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      // A decorative-by-default `focusable` keeps IE-era SVG out of the tab
      // order; the label is what carries this element, not focus.
      focusable="false"
    >
      {/* One stroke per run of consecutive samples. A reading with no neighbour
          is a dot for the same reason a one-reading series is: there is nothing
          beside it to draw a line to, and drawing one anyway would invent the
          sample the gap is there to report. */}
      {geometry.segments.map((segment, index) => {
        const key = `segment-${index}`
        if (segment.length > 1) {
          return (
            <polyline
              key={key}
              points={sparklinePointsAttribute(segment)}
              fill="none"
              stroke="currentColor"
              strokeWidth={STROKE_WIDTH}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )
        }
        const only = segment[0] as SparklinePoint
        // The latest-reading dot below already paints this one.
        if (only.x === end.x && only.y === end.y) return null
        return <circle key={key} cx={only.x} cy={only.y} r={DOT_RADIUS} fill="currentColor" />
      })}
      {/* The latest reading, marked. Without it the eye has to decide which end
          of the line is "now", and half the readers guess wrong. */}
      <circle cx={end.x} cy={end.y} r={DOT_RADIUS} fill="currentColor" />
    </svg>
  )
}
