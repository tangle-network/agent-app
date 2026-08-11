// @vitest-environment jsdom
/**
 * The four series a sparkline is normally shipped without: none, one, a flat
 * one, and one that goes below zero.
 *
 * Each is asserted on the RENDERED output rather than on the geometry alone,
 * because the failures are invisible to a unit test of the maths: a `NaN` in
 * the `points` attribute is a valid string that draws nothing, and a flat line
 * along the baseline is a valid polyline that states something false.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import {
  DEFAULT_SPARKLINE_HEIGHT,
  Sparkline,
  sparklineGeometry,
  sparklineLabel,
  sparklinePointsAttribute,
  sparklineReadings,
} from './sparkline'

function svg(container: HTMLElement): SVGSVGElement | null {
  return container.querySelector('svg')
}

describe('sparklineGeometry', () => {
  it('has no points to plot for an empty series', () => {
    const geometry = sparklineGeometry([])
    expect(geometry.points).toEqual([])
    expect(geometry.readings).toEqual([])
  })

  it('places a single reading at mid-width instead of the left edge', () => {
    const geometry = sparklineGeometry([7], { width: 100, height: 20 })
    expect(geometry.points).toHaveLength(1)
    expect(geometry.points[0]?.x).toBe(50)
  })

  it('plots a flat series at mid-height, with no NaN anywhere', () => {
    const geometry = sparklineGeometry([4, 4, 4], { width: 100, height: 20 })
    expect(geometry.points.map((point) => point.y)).toEqual([10, 10, 10])
    // The failure this guards is a divide-by-(max-min): it produces NaN, the
    // browser drops the whole polyline, and the metric that never moved is the
    // one that vanishes.
    expect(sparklinePointsAttribute(geometry.points)).not.toContain('NaN')
    expect(geometry.direction).toBe('flat')
  })

  it('spans negatives from the floor to the ceiling of the box', () => {
    const geometry = sparklineGeometry([-5, 0, 5], { width: 100, height: 20, inset: 2 })
    expect(geometry.min).toBe(-5)
    expect(geometry.max).toBe(5)
    // Lowest reading at the bottom inset, highest at the top inset — a series
    // clamped at 0 would flatten the whole negative half onto the floor.
    expect(geometry.points.map((point) => point.y)).toEqual([18, 10, 2])
    expect(geometry.direction).toBe('rising')
  })

  it('does not plot a non-finite reading as zero, and counts it as a gap', () => {
    expect(sparklineReadings([1, Number.NaN, 3, Number.POSITIVE_INFINITY])).toEqual([1, 3])
    const geometry = sparklineGeometry([10, Number.NaN, 12])
    expect(geometry.readings).toEqual([10, 12])
    expect(sparklinePointsAttribute(geometry.points)).not.toContain('NaN')
    // Not plotted is not the same as not there. The count is what the
    // accessible name has to state, and what a silent filter threw away.
    expect(geometry.gaps).toBe(1)
  })

  it('breaks the line at a missing reading instead of drawing straight across it', () => {
    const geometry = sparklineGeometry([1, Number.NaN, 3], { width: 100, height: 20, inset: 0 })
    expect(geometry.gaps).toBe(1)
    // Two runs of one sample each: there is no pair of ADJACENT readings, so
    // there is no segment to stroke. A single polyline over these two points
    // draws a rise between samples 0 and 2 that nobody measured.
    expect(geometry.segments).toHaveLength(2)
    expect(geometry.segments.map((segment) => segment.length)).toEqual([1, 1])
    // The x axis is the SAMPLE index, so the hole keeps its width — the two
    // readings sit at the ends of a three-sample window, not side by side.
    expect(geometry.points.map((point) => point.x)).toEqual([0, 100])
  })

  it('keeps consecutive readings in one run and splits only at the gap', () => {
    const geometry = sparklineGeometry([1, 2, Number.NaN, 5, 6], { width: 100, height: 20, inset: 0 })
    expect(geometry.segments.map((segment) => segment.length)).toEqual([2, 2])
    expect(geometry.segments[0]?.map((point) => point.x)).toEqual([0, 25])
    expect(geometry.segments[1]?.map((point) => point.x)).toEqual([75, 100])
  })

  it('counts every sample it could not read, including a series with nothing usable', () => {
    const geometry = sparklineGeometry([Number.NaN, Number.POSITIVE_INFINITY])
    expect(geometry.readings).toEqual([])
    expect(geometry.points).toEqual([])
    expect(geometry.segments).toEqual([])
    expect(geometry.gaps).toBe(2)
  })

  it('calls a series that returns to its start net unchanged, not rising', () => {
    expect(sparklineGeometry([2, 9, 2]).direction).toBe('flat')
  })
})

describe('sparklineLabel', () => {
  it('names the metric, the count, the range and the direction', () => {
    const label = sparklineLabel([1, 5, 9], { label: 'Daily spend', format: (v) => `$${v}` })
    expect(label).toBe('Daily spend: 3 readings, range $1 to $9, rising from $1 to $9')
  })

  it('says a stable metric is unchanged rather than quoting a range of zero', () => {
    expect(sparklineLabel([4, 4], { label: 'Pass rate' })).toBe('Pass rate: 2 readings, unchanged at 4')
  })

  it('distinguishes a round trip from a rise', () => {
    expect(sparklineLabel([2, 9, 2], { label: 'Runs' })).toContain('net unchanged from 2 to 2')
  })

  it('reports one reading and none at all as different things', () => {
    expect(sparklineLabel([3], { label: 'Runs' })).toBe('Runs: one reading, 3')
    expect(sparklineLabel([], { label: 'Runs' })).toBe('Runs: no readings yet')
  })

  it('states the readings it could not use rather than announcing a shorter series', () => {
    // Measured before this fix: `[1, NaN, 3]` announced "2 readings, range 1 to
    // 3, rising from 1 to 3" — a complete-sounding sentence about a series with
    // a hole in it. The card's figure slot already refuses to let a
    // non-measurement look measured; the series says it in the same words.
    expect(sparklineLabel([1, Number.NaN, 3], { label: 'Cost' })).toBe(
      'Cost: 2 readings, 1 not available, range 1 to 3, rising from 1 to 3',
    )
    expect(sparklineLabel([4, Number.NaN, 4], { label: 'Pass rate' })).toBe(
      'Pass rate: 2 readings, 1 not available, unchanged at 4',
    )
    expect(sparklineLabel([Number.NaN, 7], { label: 'Runs' })).toBe('Runs: one reading, 1 not available, 7')
  })

  it('separates a metric with no history from one whose readings were unusable', () => {
    // "no readings yet" is a claim about a NEW metric. A series that arrived
    // full of NaN is a broken producer, and borrowing that sentence hides it.
    expect(sparklineLabel([], { label: 'Cost' })).toBe('Cost: no readings yet')
    expect(sparklineLabel([Number.NaN, Number.NaN], { label: 'Cost' })).toBe('Cost: no readings, 2 not available')
  })
})

describe('<Sparkline>', () => {
  it('renders an explicit empty state — never a line — with no readings', () => {
    const { container } = render(<Sparkline values={[]} label="Daily spend" />)
    expect(svg(container)).toBeNull()
    const empty = container.querySelector('[data-sparkline="empty"]')
    expect(empty?.textContent).toContain('No history yet')
    // The metric still reaches a screen reader: on a deck of cards, an
    // unattributed "No history yet" belongs to no metric in particular.
    expect(empty?.textContent).toContain('Daily spend')
  })

  it('renders a point, not a line, for a single reading', () => {
    const { container } = render(<Sparkline values={[12]} label="Runs" />)
    expect(container.querySelector('[data-sparkline="point"]')).not.toBeNull()
    expect(container.querySelector('polyline')).toBeNull()
    expect(container.querySelector('circle')).not.toBeNull()
  })

  it('draws a flat series as a line across the middle', () => {
    const { container } = render(<Sparkline values={[6, 6, 6, 6]} label="Pass rate" />)
    const points = container.querySelector('polyline')?.getAttribute('points') ?? ''
    expect(points).not.toContain('NaN')
    const mid = DEFAULT_SPARKLINE_HEIGHT / 2
    expect(points.split(' ').every((pair) => pair.endsWith(`,${mid}`))).toBe(true)
  })

  it('carries an accessible name with the metric, its range and its direction', () => {
    render(<Sparkline values={[9, 5, 1]} label="Daily spend" format={(v) => `$${v}`} />)
    const chart = screen.getByRole('img', { name: /Daily spend/ })
    const name = chart.getAttribute('aria-label') ?? ''
    expect(name).toContain('range $1 to $9')
    expect(name).toContain('falling from $9 to $1')
    expect(chart.getAttribute('data-direction')).toBe('falling')
  })

  it('leaves no stray separator in the empty state class attribute', () => {
    const { container } = render(<Sparkline values={[]} label="Runs" />)
    // Interpolating an absent `className` emitted `class="… text-muted-foreground "`
    // on every caller that passed none.
    const attribute = container.querySelector('[data-sparkline="empty"]')?.getAttribute('class') ?? ''
    expect(attribute).toBe(attribute.trim())
    expect(attribute).not.toContain('  ')
  })

  it('joins a caller class with exactly one separator', () => {
    const { container } = render(<Sparkline values={[]} label="Runs" className="mt-2" />)
    expect(container.querySelector('[data-sparkline="empty"]')?.getAttribute('class')).toBe(
      'text-[11px] text-muted-foreground mt-2',
    )
  })

  it('renders a gap as a break in the drawing, never as a continuous line', () => {
    const { container } = render(<Sparkline values={[1, Number.NaN, 3]} label="Cost" />)
    const chart = screen.getByRole('img', { name: /Cost/ })
    expect(chart.getAttribute('data-gaps')).toBe('1')
    // Neither reading has a neighbour, so there is nothing to stroke: two dots.
    // A polyline here is the two-point line the fix exists to stop drawing.
    expect(container.querySelectorAll('polyline')).toHaveLength(0)
    expect(container.querySelectorAll('circle')).toHaveLength(2)
    expect(chart.getAttribute('aria-label')).toContain('1 not available')
  })

  it('draws one stroke per run of consecutive readings', () => {
    const { container } = render(<Sparkline values={[1, 2, Number.NaN, 5, 6]} label="Cost" />)
    expect(container.querySelectorAll('polyline')).toHaveLength(2)
    expect(svg(container)?.getAttribute('data-gaps')).toBe('1')
    // One end marker, because there is one latest reading.
    expect(container.querySelectorAll('circle')).toHaveLength(1)
  })

  it('carries no gap attribute at all for a series with none', () => {
    const { container } = render(<Sparkline values={[1, 2, 3]} label="Cost" />)
    expect(svg(container)?.hasAttribute('data-gaps')).toBe(false)
    expect(container.querySelectorAll('polyline')).toHaveLength(1)
  })

  it('says a series that arrived unreadable is unavailable, not new', () => {
    const { container } = render(<Sparkline values={[Number.NaN, Number.NaN]} label="Cost" />)
    expect(container.querySelector('[data-sparkline="empty"]')).toBeNull()
    const unavailable = container.querySelector('[data-sparkline="unavailable"]')
    expect(unavailable?.textContent).toContain('No readings available')
    expect(unavailable?.textContent).not.toContain('No history yet')
    // …and the sentence assistive tech gets names the metric and the count.
    expect(unavailable?.textContent).toContain('Cost: no readings, 2 not available')
  })

  it('is reachable by its metric name rather than as an unnamed graphic', () => {
    render(<Sparkline values={[1, 2]} label="Mission throughput" />)
    // A sparkline with no accessible name is decoration a screen reader cannot
    // report — this query is exactly what it would fail.
    expect(screen.getByRole('img', { name: /Mission throughput/ })).toBeTruthy()
  })
})
