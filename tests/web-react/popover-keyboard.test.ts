// @vitest-environment jsdom
/**
 * The popover keyboard model the pickers gained: Escape closes and returns
 * focus to the trigger, the trigger advertises `aria-expanded`/`aria-haspopup`,
 * and options carry a visible focus ring. Proven through `EffortPicker` (the
 * smallest consumer of `usePopover`); ModelPicker and the gear menu share the
 * same hook.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { EffortPicker } from '../../src/web-react/index'

afterEach(cleanup)

describe('popover keyboard model (EffortPicker)', () => {
  it('trigger advertises the ARIA popup contract and toggles aria-expanded', () => {
    render(createElement(EffortPicker, { value: 'medium', onChange: vi.fn() }))
    const trigger = screen.getByRole('button', { name: /Medium/ })
    expect(trigger.getAttribute('aria-haspopup')).toBe('true')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('Escape closes the popover and returns focus to the trigger', () => {
    render(createElement(EffortPicker, { value: 'medium', onChange: vi.fn() }))
    const trigger = screen.getByRole('button', { name: /Medium/ })
    fireEvent.click(trigger)
    expect(screen.queryByRole('menu')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('outside mousedown closes the popover', () => {
    render(createElement(EffortPicker, { value: 'medium', onChange: vi.fn() }))
    fireEvent.click(screen.getByRole('button', { name: /Medium/ }))
    expect(screen.queryByRole('menu')).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('options expose selected state and a focus-visible ring', () => {
    render(createElement(EffortPicker, { value: 'high', onChange: vi.fn() }))
    fireEvent.click(screen.getByRole('button', { name: /High/ }))
    const selected = screen.getByRole('menuitemradio', { name: 'High' })
    expect(selected.getAttribute('aria-checked')).toBe('true')
    expect(selected.className).toContain('focus-visible:ring-2')
    expect(screen.getByRole('menuitemradio', { name: 'Low' }).getAttribute('aria-checked')).toBe('false')
  })

  it('Escape is inert while the popover is closed (no global key swallowing)', () => {
    render(createElement(EffortPicker, { value: 'medium', onChange: vi.fn() }))
    // Closed popover must not register a document keydown listener; pressing
    // Escape should be a no-op rather than throwing or focusing anything.
    expect(() => fireEvent.keyDown(document, { key: 'Escape' })).not.toThrow()
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
