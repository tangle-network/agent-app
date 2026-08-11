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

  it('drops non-finite readings rather than plotting them as zero', () => {
    expect(sparklineReadings([1, Number.NaN, 3, Number.POSITIVE_INFINITY])).toEqual([1, 3])
    const geometry = sparklineGeometry([10, Number.NaN, 12])
    expect(geometry.readings).toEqual([10, 12])
    expect(sparklinePointsAttribute(geometry.points)).not.toContain('NaN')
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

  it('is reachable by its metric name rather than as an unnamed graphic', () => {
    render(<Sparkline values={[1, 2]} label="Mission throughput" />)
    // A sparkline with no accessible name is decoration a screen reader cannot
    // report — this query is exactly what it would fail.
    expect(screen.getByRole('img', { name: /Mission throughput/ })).toBeTruthy()
  })
})
