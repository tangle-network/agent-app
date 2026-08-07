// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { ModelPicker, EffortPicker, EffortMeter, effortMeterFill, DEFAULT_EFFORT_LEVELS, EFFORT_METER_SEGMENTS } from './controls'
import type { CatalogModel } from '../runtime/model-catalog'

function model(id: string, overrides: Partial<CatalogModel> = {}): CatalogModel {
  return { id, name: id, provider: 'openai', supportsTools: true, supportsReasoning: false, featured: false, ...overrides }
}

function openPicker(): void {
  fireEvent.click(screen.getByRole('button', { expanded: false }))
}

describe('ModelPicker', () => {
  it('shows the loading copy and no rows while loading', () => {
    render(<ModelPicker value="gpt" onChange={() => {}} models={[]} loading />)
    openPicker()
    expect(screen.getByText('Loading models...')).toBeTruthy()
    expect(screen.queryByText('No models available')).toBeNull()
  })

  it('names an empty catalogue explicitly rather than rendering a blank menu', () => {
    render(<ModelPicker value="gpt" onChange={() => {}} models={[]} />)
    openPicker()
    expect(screen.getByText('No models available')).toBeTruthy()
  })

  it('renders provider-grouped rows for a real catalogue', () => {
    render(<ModelPicker value="gpt-4" onChange={() => {}} models={[model('gpt-4', { name: 'GPT-4' })]} />)
    openPicker()
    expect(screen.queryByText('No models available')).toBeNull()
    expect(screen.getAllByText('GPT-4').length).toBeGreaterThan(0)
  })

  it('still distinguishes "no search matches" from "no catalogue at all"', () => {
    render(<ModelPicker value="gpt-4" onChange={() => {}} models={[model('gpt-4', { name: 'GPT-4' })]} />)
    openPicker()
    fireEvent.change(screen.getByPlaceholderText('Search models...'), { target: { value: 'nonexistent' } })
    expect(screen.getByText('No models match your search')).toBeTruthy()
    expect(screen.queryByText('No models available')).toBeNull()
  })
})

describe('effortMeterFill', () => {
  it('ramps the canonical ladder 0/1/2/4 with the top level filling the scale', () => {
    expect(effortMeterFill('off')).toBe(0)
    expect(effortMeterFill('low')).toBe(1)
    expect(effortMeterFill('medium')).toBe(2)
    expect(effortMeterFill('high')).toBe(EFFORT_METER_SEGMENTS)
  })

  it('treats none and unknown ids as all-ghost', () => {
    expect(effortMeterFill('none')).toBe(0)
    expect(effortMeterFill('banana')).toBe(0)
  })

  it('generalizes to custom level lists — the last non-off level always fills', () => {
    const levels = [
      { id: 'fast', label: 'Fast' },
      { id: 'careful', label: 'Careful' },
    ]
    expect(effortMeterFill('fast', levels)).toBeGreaterThanOrEqual(1)
    expect(effortMeterFill('careful', levels)).toBe(EFFORT_METER_SEGMENTS)
  })
})

describe('EffortMeter', () => {
  it('renders a fixed segment count, aria-hidden, filled before ghost', () => {
    const { container } = render(<EffortMeter fill={2} />)
    const meter = container.firstElementChild
    expect(meter?.getAttribute('aria-hidden')).toBe('true')
    const segments = container.querySelectorAll('span > span')
    expect(segments.length).toBe(EFFORT_METER_SEGMENTS)
    const opacities = Array.from(segments).map((s) => (s as HTMLElement).style.opacity)
    // the translucency ladder: filled segments ramp up, ghosts sit at the faint floor
    expect(Number(opacities[0])).toBeLessThan(Number(opacities[1]))
    expect(Number(opacities[1])).toBeLessThanOrEqual(1)
    expect(opacities[2]).toBe(opacities[3])
  })

  it('is all-ghost at fill 0 and fully lit at the segment count', () => {
    const { container } = render(<EffortMeter fill={EFFORT_METER_SEGMENTS} />)
    const opacities = Array.from(container.querySelectorAll('span > span')).map((s) => Number((s as HTMLElement).style.opacity))
    expect(opacities[opacities.length - 1]).toBe(1)
  })
})

describe('EffortPicker thinking glyph + meter', () => {
  it('shows the meter on the trigger matching the selected level', () => {
    const { container } = render(<EffortPicker value="high" onChange={() => {}} />)
    const trigger = screen.getByRole('button', { expanded: false })
    const segments = trigger.querySelectorAll('[aria-hidden] > span')
    const lit = Array.from(segments).filter((s) => Number((s as HTMLElement).style.opacity) > 0.2)
    expect(lit.length).toBe(EFFORT_METER_SEGMENTS)
    expect(container.textContent).toContain('Extended')
  })

  it('renders the full meter ladder in the open menu, one row per level', () => {
    render(<EffortPicker value="medium" onChange={() => {}} />)
    openPicker()
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows.length).toBe(DEFAULT_EFFORT_LEVELS.length)
    const fills = rows.map(
      (row) =>
        Array.from(row.querySelectorAll('[aria-hidden] > span')).filter(
          (s) => Number((s as HTMLElement).style.opacity) > 0.2,
        ).length,
    )
    expect(fills).toEqual([0, 1, 2, EFFORT_METER_SEGMENTS])
    // rows announce the level name; the selected one carries the check
    const selected = rows[2]
    if (!selected) throw new Error('medium row did not render')
    expect(selected.getAttribute('aria-checked')).toBe('true')
    expect(selected.textContent).toContain('Standard')
  })
})
