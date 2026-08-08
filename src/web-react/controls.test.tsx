// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import {
  ModelPicker,
  EffortPicker,
  EffortMeter,
  effortMeterFill,
  effortLevelLabel,
  effortLevelsFromIds,
  reconcileEffortLevels,
  DEFAULT_EFFORT_LEVELS,
  EFFORT_METER_SEGMENTS,
} from './controls'
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

describe('effortLevelLabel', () => {
  it('keeps the canonical vocabulary for ids this package names', () => {
    expect(effortLevelLabel('low')).toBe('Quick')
    expect(effortLevelLabel('high')).toBe('Extended')
  })

  it('makes an unnamed id readable as ITSELF, never as another level', () => {
    expect(effortLevelLabel('auto')).toBe('Auto')
    expect(effortLevelLabel('ultra-code')).toBe('Ultra code')
    expect(effortLevelLabel('x_high')).toBe('X high')
  })
})

describe('effortLevelsFromIds', () => {
  it('maps a backend id list onto the canonical labels in order', () => {
    expect(effortLevelsFromIds(['auto', 'low', 'high'])).toEqual([
      { id: 'auto', label: 'Auto' },
      { id: 'low', label: 'Quick' },
      { id: 'high', label: 'Extended' },
    ])
  })
})

describe('reconcileEffortLevels', () => {
  const declared = [
    { id: 'low', label: 'Quick' },
    { id: 'medium', label: 'Standard' },
    { id: 'high', label: 'Extended' },
  ]

  it('returns the declared list untouched when it carries the value', () => {
    expect(reconcileEffortLevels('medium', declared)).toBe(declared)
  })

  it('admits a selected value the declaration omits, under its own name', () => {
    expect(reconcileEffortLevels('auto', declared)).toEqual([{ id: 'auto', label: 'Auto' }, ...declared])
  })

  it('admits nothing for a blank value — there is no honest label for it', () => {
    expect(reconcileEffortLevels('', declared)).toBe(declared)
  })
})

describe('EffortPicker with a value the declared levels omit', () => {
  // The migration defect this guards: the removed ComposerAgentControls took an
  // `available` list whose picker injected the `auto` sentinel ITSELF, so a
  // product mapping that list straight onto `levels` omits `auto` while its
  // sessions still run on it. Resolving the unlisted value to a list entry
  // renders a depth the system is not using.
  const declared = [
    { id: 'low', label: 'Quick' },
    { id: 'medium', label: 'Standard' },
    { id: 'high', label: 'Extended' },
  ]

  it('labels the trigger with the running value, not another level', () => {
    const { container } = render(<EffortPicker value="auto" onChange={() => {}} levels={declared} />)
    expect(container.textContent).toContain('Auto')
    expect(container.textContent).not.toContain('Extended')
    expect(container.textContent).not.toContain('Standard')
  })

  it('claims no strength for a value it cannot place on the ladder', () => {
    render(<EffortPicker value="auto" onChange={() => {}} levels={declared} />)
    const trigger = screen.getByRole('button', { expanded: false })
    // an all-ghost meter is what `off` looks like; "cannot place" is not "off"
    expect(trigger.querySelectorAll('[aria-hidden] > span').length).toBe(0)
  })

  it('offers the running value as a checked row and still offers every declared level', () => {
    render(<EffortPicker value="auto" onChange={() => {}} levels={declared} />)
    openPicker()
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows.map((r) => r.textContent)).toEqual(['Auto', 'Quick', 'Standard', 'Extended'])
    expect(rows[0]?.getAttribute('aria-checked')).toBe('true')
  })

  it('leaves the declared levels on the same rungs they had without it', () => {
    render(<EffortPicker value="auto" onChange={() => {}} levels={declared} />)
    openPicker()
    const fills = screen
      .getAllByRole('menuitemradio')
      .map(
        (row) =>
          Array.from(row.querySelectorAll('[aria-hidden] > span')).filter(
            (s) => Number((s as HTMLElement).style.opacity) > 0.2,
          ).length,
      )
    // reconciled row draws no meter at all; low/medium/high keep 1/2/4
    expect(fills).toEqual([0, 1, 2, EFFORT_METER_SEGMENTS])
  })

  it('drops the reconciled row once the user picks a declared level', () => {
    const onChange = vi.fn()
    const { rerender } = render(<EffortPicker value="auto" onChange={onChange} levels={declared} />)
    openPicker()
    fireEvent.click(screen.getByText('Quick'))
    expect(onChange).toHaveBeenCalledWith('low')
    rerender(<EffortPicker value="low" onChange={onChange} levels={declared} />)
    openPicker()
    expect(screen.queryByText('Auto')).toBeNull()
    expect(screen.getAllByRole('menuitemradio').length).toBe(declared.length)
  })

  it('renders no selection for a blank value rather than resolving it to a level', () => {
    const { container } = render(<EffortPicker value="" onChange={() => {}} levels={declared} />)
    expect(container.textContent).not.toContain('Standard')
    expect(container.textContent).not.toContain('Extended')
    expect(container.textContent).toContain('—')
  })
})
