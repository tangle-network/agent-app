// @vitest-environment jsdom
/**
 * The CommandPalette surface: Cmd/Ctrl+K opens a portaled, centered overlay;
 * focus stays in the input; ArrowUp/ArrowDown move `aria-activedescendant`
 * across the FLAT result list; Enter selects and closes; Escape and the
 * backdrop close; closing returns focus to whatever had it.
 *
 * The structural half of the popover canon is pinned here too: the panel
 * portals OUT of the host subtree and positions `fixed`, never `absolute`
 * inside a container a host can clip (the production defect AGENTS.md's
 * "UI chrome ownership" section is built around).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { CommandPalette, POPOVER_SURFACE_ATTR, type CommandPaletteItem } from '../../src/web-react/index'

afterEach(cleanup)

const ITEMS: CommandPaletteItem[] = [
  { id: 's2', group: 'Sessions', label: 'Pricing page rewrite', recentAt: '2026-08-17T10:00:00.000Z' },
  { id: 's1', group: 'Sessions', label: 'Onboarding audit', recentAt: '2026-08-15T10:00:00.000Z' },
  { id: 'a1', group: 'Actions', label: 'New chat', hint: '⌘N' },
  { id: 'a2', group: 'Actions', label: 'Toggle theme', description: 'Switch dark and light' },
]

function renderPalette(props: Partial<Parameters<typeof CommandPalette>[0]> = {}) {
  const onSelect = vi.fn()
  const utils = render(createElement(CommandPalette, { items: ITEMS, onSelect, ...props }))
  return { onSelect, ...utils }
}

function openByHotkey(key: 'k' = 'k', meta = true) {
  fireEvent.keyDown(document, { key, metaKey: meta, ctrlKey: !meta })
}

function optionList(): HTMLElement[] {
  return screen.queryAllByRole('option')
}

describe('CommandPalette', () => {
  it('is closed by default and Cmd+K opens it with the input focused', () => {
    renderPalette()
    expect(screen.queryByRole('dialog')).toBeNull()
    openByHotkey('k', true)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
  })

  it('Ctrl+K opens it too (non-Apple modifier)', () => {
    renderPalette()
    openByHotkey('k', false)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('portals the panel out of the host subtree and positions it fixed, stamped for audits', () => {
    const { container } = renderPalette()
    openByHotkey('k', true)
    const dialog = screen.getByRole('dialog')
    expect(container.contains(dialog)).toBe(false)
    expect(dialog.getAttribute(POPOVER_SURFACE_ATTR)).toBeTruthy()
    // `fixed` positioning lives on the click-transparent centering wrapper —
    // the dialog itself must never carry `absolute` (the host-clip defect).
    const wrapper = dialog.parentElement as HTMLElement
    expect(wrapper.className).toContain('fixed')
    expect(wrapper.className).not.toMatch(/\babsolute\b/)
    expect(dialog.className).not.toMatch(/\babsolute\b/)
  })

  it('renders grouped results with section headers', () => {
    renderPalette({ open: true, onOpenChange: () => {} })
    expect(screen.getByText('Sessions')).toBeTruthy()
    expect(screen.getByText('Actions')).toBeTruthy()
    expect(optionList()).toHaveLength(4)
  })

  it('filters as the query types and resets the active row', () => {
    renderPalette({ open: true, onOpenChange: () => {} })
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'theme' } })
    const options = optionList()
    expect(options).toHaveLength(1)
    expect(options[0]?.textContent).toContain('Toggle theme')
    // a filtered list drops the now-empty Sessions header
    expect(screen.queryByText('Sessions')).toBeNull()
  })

  it('ArrowDown/ArrowUp move the active row and wrap at both ends', () => {
    renderPalette({ open: true, onOpenChange: () => {} })
    const input = screen.getByRole('combobox')
    expect(input.getAttribute('aria-activedescendant')).toBe(optionList()[0]?.id)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toBe(optionList()[1]?.id)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.getAttribute('aria-activedescendant')).toBe(optionList()[0]?.id)
    // wrap upward from the first row lands on the last
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.getAttribute('aria-activedescendant')).toBe(optionList()[3]?.id)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toBe(optionList()[0]?.id)
  })

  it('aria-selected follows the active row', () => {
    renderPalette({ open: true, onOpenChange: () => {} })
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const options = optionList()
    expect(options[1]?.getAttribute('aria-selected')).toBe('true')
    expect(options[0]?.getAttribute('aria-selected')).toBe('false')
  })

  it('Enter selects the active item, reports it, and closes', () => {
    const { onSelect } = renderPalette()
    openByHotkey('k', true)
    const input = screen.getByRole('combobox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith(ITEMS[1])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('click selects a row', () => {
    const { onSelect } = renderPalette({ open: true, onOpenChange: () => {} })
    fireEvent.click(screen.getByText('Toggle theme'))
    expect(onSelect).toHaveBeenCalledWith(ITEMS[3])
  })

  it('Escape closes and returns focus to the previously focused element', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    renderPalette()
    openByHotkey('k', true)
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('the backdrop closes on mousedown', () => {
    renderPalette()
    openByHotkey('k', true)
    fireEvent.mouseDown(screen.getByTestId('command-palette-backdrop'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reopening resets the query', () => {
    renderPalette()
    openByHotkey('k', true)
    const input = screen.getByRole('combobox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'theme' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    openByHotkey('k', true)
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('')
    expect(optionList()).toHaveLength(4)
  })

  it('shows the empty state naming the query', () => {
    renderPalette({ open: true, onOpenChange: () => {} })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz-no-match' } })
    expect(screen.getByText('No results for “zzz-no-match”')).toBeTruthy()
    expect(optionList()).toHaveLength(0)
    // Enter with no rows is a no-op, not a crash
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
  })

  it('shows the loading row instead of a premature empty state', () => {
    renderPalette({ open: true, onOpenChange: () => {}, loading: true, items: [] })
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(screen.queryByText('Nothing here yet')).toBeNull()
  })

  it('controlled open state reports through onOpenChange', () => {
    const onOpenChange = vi.fn()
    renderPalette({ open: false, onOpenChange })
    openByHotkey('k', true)
    expect(onOpenChange).toHaveBeenCalledWith(true)
    // controlled: the parent did not flip the prop, so the palette stays closed
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('seeds the query from initialQuery', () => {
    renderPalette({ open: true, onOpenChange: () => {}, initialQuery: 'theme' })
    expect(optionList()).toHaveLength(1)
  })
})
