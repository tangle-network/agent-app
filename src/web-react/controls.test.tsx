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

  it('shows current models before stale models even when the caller sends stale order', () => {
    render(<ModelPicker
      value="gpt-4.1-mini"
      onChange={() => {}}
      models={[
        model('gpt-4.1-mini'),
        model('gpt-5.5'),
        model('gpt-5.6-luna'),
      ]}
    />)
    openPicker()
    const rows = screen.getAllByRole('button').filter(
      (button) => !button.hasAttribute('aria-expanded') && button.textContent?.startsWith('gpt-'),
    )
    expect(rows.map((row) => row.textContent)).toEqual(['gpt-5.6-luna', 'gpt-5.5', 'gpt-4.1-mini'])
  })

  it('does not promote an old featured model above a newer release', () => {
    render(<ModelPicker
      value="gpt-4.1-mini"
      onChange={() => {}}
      models={[
        model('gpt-4.1-mini', { featured: true }),
        model('gpt-5.6-luna'),
      ]}
    />)
    openPicker()
    expect(screen.queryByText('Recommended')).toBeNull()
    const rows = screen.getAllByRole('button').filter(
      (button) => !button.hasAttribute('aria-expanded') && button.textContent?.startsWith('gpt-'),
    )
    expect(rows.map((row) => row.textContent)).toEqual(['gpt-5.6-luna', 'gpt-4.1-mini'])
  })

  it('limits recommendations without hiding the remaining providers', () => {
    const providers = ['anthropic', 'openai', 'google', 'xai', 'deepseek']
    render(<ModelPicker
      value="claude-fable-5-1"
      onChange={() => {}}
      models={providers.map((provider, index) => model(
        provider === 'anthropic' ? 'claude-fable-5-1' : `${provider}/model-${index}`,
        { provider, featured: true },
      ))}
    />)
    openPicker()

    const recommendedHeader = screen.getByText('Recommended')
    let recommendedCount = 0
    let sibling = recommendedHeader.nextElementSibling
    while (sibling?.tagName === 'BUTTON') {
      recommendedCount += 1
      sibling = sibling.nextElementSibling
    }
    expect(recommendedCount).toBe(3)
    expect(screen.getByText('xai')).toBeTruthy()
    expect(screen.getByText('deepseek')).toBeTruthy()
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

  it('names the rungs above `high` that a harness actually applies', () => {
    expect(effortLevelLabel('xhigh')).toBe('Extra')
    expect(effortLevelLabel('ultracode')).toBe('Ultra')
  })

  it('does not OFFER those rungs by default — most backends do not apply them', () => {
    expect(DEFAULT_EFFORT_LEVELS.map((l) => l.id)).toEqual(['off', 'low', 'medium', 'high'])
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

describe('effortMeterFill — a sentinel has no rung', () => {
  const withAuto = [
    { id: 'auto', label: 'Auto' },
    { id: 'none', label: 'None' },
    { id: 'high', label: 'Extended' },
  ]

  it('draws nothing for `auto`, which names a policy and not a depth', () => {
    // Measured defect: with `auto` declared first, every harness read "Auto" at
    // a FULL meter — including one with no agent to think at all.
    expect(effortMeterFill('auto', withAuto)).toBe(0)
  })

  it('does not let `auto` shift where the real rungs sit', () => {
    expect(effortMeterFill('high', withAuto)).toBe(EFFORT_METER_SEGMENTS)
    expect(effortMeterFill('none', withAuto)).toBe(0)
  })
})

/**
 * `EffortPicker` is a PUBLISHED export, so the width switch has to be opt-in:
 * a product mounting it bare on a composer row keeps the shrink-wrapped pill it
 * has today, and only a caller that asks for `fullWidth` — the compact
 * `AgentSessionControls` gear popover does — gets an expanding one.
 *
 * The panel is portaled, so a full-width TRIGGER does not widen its menu on its
 * own: `matchTriggerWidth` is what carries the width across the portal, and
 * that is asserted here because jsdom reports every rect as zero and cannot see
 * the resulting pixels.
 */
describe('EffortPicker width', () => {
  function root(trigger: HTMLElement): HTMLElement {
    const parent = trigger.parentElement
    if (!parent) throw new Error('picker root did not render')
    return parent
  }

  it('shrink-wraps by default', () => {
    render(<EffortPicker value="medium" onChange={() => {}} />)
    const trigger = screen.getByRole('button', { expanded: false })
    expect(root(trigger).className).toContain('inline-flex')
    expect(root(trigger).className).not.toContain('w-full')
    expect(trigger.className).not.toContain('w-full')
  })

  it('fills its container when asked', () => {
    render(<EffortPicker value="medium" onChange={() => {}} fullWidth />)
    const trigger = screen.getByRole('button', { expanded: false })
    expect(root(trigger).className).toContain('w-full')
    expect(root(trigger).className).not.toContain('inline-flex')
    expect(trigger.className).toContain('w-full')
  })

  it('carries the trigger width across the portal only when full width', () => {
    const { unmount } = render(<EffortPicker value="medium" onChange={() => {}} fullWidth />)
    openPicker()
    expect(screen.getByRole('menu').getAttribute('style')).toContain('min-width')
    unmount()

    render(<EffortPicker value="medium" onChange={() => {}} />)
    openPicker()
    expect(screen.getByRole('menu').getAttribute('style')).not.toContain('min-width')
  })
})

/**
 * The trigger VARIANT. `chip` is the shipped 36px bordered pill and the
 * default, so a consumer that names no variant renders the trigger it rendered
 * before the prop existed; `quiet` is the borderless 28px text button a
 * composer whose card already draws the border opts into. jsdom paints
 * nothing, so what is pinned is the class contract: the border, the card fill,
 * and the pill radius are what the quiet trigger must NOT carry and the chip
 * must — and the menu behind either trigger is the same menu.
 */
describe('picker trigger variant', () => {
  const classesOf = (el: HTMLElement) => el.className.split(/\s+/).filter(Boolean)
  const borderClasses = (el: HTMLElement) => classesOf(el).filter((c) => /^border(-|$)/.test(c))

  function trigger(): HTMLElement {
    return screen.getByRole('button', { expanded: false })
  }

  it('ModelPicker defaults to the bordered chip', () => {
    render(<ModelPicker value="gpt-4" onChange={() => {}} models={[model('gpt-4', { name: 'GPT-4' })]} />)
    const classes = classesOf(trigger())
    expect(classes).toContain('border')
    expect(classes).toContain('border-border')
    expect(classes).toContain('bg-card')
    expect(classes).toContain('rounded-full')
    expect(classes).toContain('font-medium')
  })

  it('ModelPicker quiet draws no border, no card fill, no pill radius', () => {
    render(<ModelPicker value="gpt-4" onChange={() => {}} models={[model('gpt-4', { name: 'GPT-4' })]} variant="quiet" />)
    const classes = classesOf(trigger())
    expect(borderClasses(trigger())).toEqual([])
    expect(classes).not.toContain('bg-card')
    expect(classes).not.toContain('rounded-full')
    expect(classes).not.toContain('font-medium')
    expect(classes).toContain('h-7')
    expect(classes).toContain('rounded-md')
    expect(classes).toContain('font-normal')
    expect(classes).toContain('text-muted-foreground')
    expect(classes).toContain('hover:bg-accent')
  })

  it('EffortPicker defaults to the bordered chip', () => {
    render(<EffortPicker value="medium" onChange={() => {}} />)
    const classes = classesOf(trigger())
    expect(classes).toContain('border')
    expect(classes).toContain('border-border')
    expect(classes).toContain('bg-card')
    expect(classes).toContain('rounded-full')
    expect(classes).toContain('min-h-[36px]')
  })

  it('EffortPicker quiet draws no border, no card fill, no pill radius', () => {
    render(<EffortPicker value="medium" onChange={() => {}} variant="quiet" />)
    const classes = classesOf(trigger())
    expect(borderClasses(trigger())).toEqual([])
    expect(classes).not.toContain('bg-card')
    expect(classes).not.toContain('rounded-full')
    expect(classes).not.toContain('min-h-[36px]')
    expect(classes).toContain('h-7')
    expect(classes).toContain('font-normal')
    expect(classes).toContain('text-muted-foreground')
  })

  it('quiet keeps the width switch the compact panel relies on', () => {
    render(<EffortPicker value="medium" onChange={() => {}} variant="quiet" fullWidth />)
    expect(classesOf(trigger())).toContain('w-full')
  })

  it('quiet answers keyboard focus with the same ring as the composer buttons', () => {
    render(<EffortPicker value="medium" onChange={() => {}} variant="quiet" />)
    const classes = classesOf(trigger())
    expect(classes).toContain('focus-visible:ring-2')
    expect(classes).toContain('focus-visible:ring-ring')
  })

  it('stamps the open state on the trigger so the quiet fill can read it', () => {
    render(<EffortPicker value="medium" onChange={() => {}} variant="quiet" />)
    const el = trigger()
    expect(el.getAttribute('data-state')).toBe('closed')
    expect(classesOf(el)).toContain('data-[state=open]:bg-accent')
    fireEvent.click(el)
    expect(el.getAttribute('data-state')).toBe('open')
  })

  it('opens the same menu behind a quiet trigger as behind a chip', () => {
    const { unmount } = render(<EffortPicker value="medium" onChange={() => {}} />)
    openPicker()
    const chipRows = screen.getAllByRole('menuitemradio').map((r) => r.textContent)
    unmount()

    render(<EffortPicker value="medium" onChange={() => {}} variant="quiet" />)
    openPicker()
    expect(screen.getAllByRole('menuitemradio').map((r) => r.textContent)).toEqual(chipRows)
  })
})
