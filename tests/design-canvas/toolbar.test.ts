// @vitest-environment jsdom
/**
 * Toolbar control-primitive contract. Covers the overhaul: the root never
 * scrolls horizontally (flex-wrap, no overflow-x-auto), the font/fit/preset
 * controls are popover dropdowns rather than native <select>/<input>, color is
 * a swatch button that opens a picker popover, and the kept glyph behaviors
 * (aria-pressed active state, commit-on-change) still fire the same commands.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Toolbar, type ToolbarProps } from '../../src/design-canvas-react/components/Toolbar'
import type { ScenePage, TextElement, ImageElement } from '../../src/design-canvas/model'

afterEach(cleanup)

const PAGE: ScenePage = {
  id: 'page-1',
  name: 'Page 1',
  width: 1080,
  height: 1080,
  background: '#ffffff',
  bleed: null,
  guides: { vertical: [], horizontal: [] },
  elements: [],
}

const TEXT_EL: TextElement = {
  id: 'text-1',
  name: 'Heading',
  kind: 'text',
  x: 0,
  y: 0,
  rotation: 0,
  opacity: 1,
  locked: false,
  visible: true,
  text: 'Hello',
  width: 200,
  fontFamily: 'Inter',
  fontSize: 24,
  fontStyle: 'normal',
  fill: '#111111',
  align: 'left',
  lineHeight: 1.2,
  letterSpacing: 0,
}

const IMAGE_EL: ImageElement = {
  id: 'image-1',
  name: 'Photo',
  kind: 'image',
  x: 0,
  y: 0,
  rotation: 0,
  opacity: 1,
  locked: false,
  visible: true,
  width: 400,
  height: 300,
  src: 'https://cdn.example.com/p.png',
  fit: 'cover',
}

function setup(overrides: Partial<ToolbarProps> = {}) {
  const handlers = {
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onToggleGrid: vi.fn(),
    onToggleSnap: vi.fn(),
    onToggleRulers: vi.fn(),
    onToggleBleed: vi.fn(),
    onSetAttrs: vi.fn(),
    onSetPageProps: vi.fn(),
    onSetPageGuides: vi.fn(),
    onReorder: vi.fn(),
    onGroup: vi.fn(),
    onUngroup: vi.fn(),
    onDelete: vi.fn(),
    onBindSlot: vi.fn(),
  }
  const { container } = render(
    createElement(Toolbar, {
      page: PAGE,
      selectedElements: [],
      canWrite: true,
      canUndo: true,
      canRedo: true,
      gridEnabled: false,
      snapEnabled: false,
      showRulers: false,
      showBleed: false,
      ...handlers,
      ...overrides,
    }),
  )
  return { ...handlers, container }
}

describe('Toolbar layout', () => {
  it('the root strip wraps and never scrolls horizontally', () => {
    const { container } = setup({ selectedElements: [TEXT_EL] })
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toContain('flex-wrap')
    expect(root.className).not.toContain('overflow-x-auto')
  })

  it('keeps global controls (undo/redo + view toggles) present alongside selection attrs', () => {
    setup({ selectedElements: [TEXT_EL] })
    expect(screen.getByLabelText('Undo')).toBeTruthy()
    expect(screen.getByLabelText('Redo')).toBeTruthy()
    expect(screen.getByLabelText('Toggle grid')).toBeTruthy()
    expect(screen.getByLabelText('Font family')).toBeTruthy()
  })
})

describe('Toolbar glyph behavior (kept)', () => {
  it('view toggle reflects pressed state via aria-pressed', () => {
    setup({ gridEnabled: true })
    expect(screen.getByLabelText('Toggle grid').getAttribute('aria-pressed')).toBe('true')
  })

  it('align glyph marks the active alignment', () => {
    setup({ selectedElements: [{ ...TEXT_EL, align: 'center' }] })
    const center = screen.getByLabelText('Align center')
    expect(center.className).toContain('var(--brand-primary)')
  })

  it('bold glyph fires the same fontStyle patch command', () => {
    const { onSetAttrs } = setup({ selectedElements: [TEXT_EL] })
    fireEvent.click(screen.getByLabelText('Bold'))
    expect(onSetAttrs).toHaveBeenCalledWith('text-1', { fontStyle: 'bold' })
  })
})

describe('FontPicker (replaces free-text input)', () => {
  it('renders a button, not a native text input, and opens a searchable list', () => {
    setup({ selectedElements: [TEXT_EL] })
    const trigger = screen.getByLabelText('Font family')
    expect(trigger.tagName).toBe('BUTTON')
    fireEvent.click(trigger)
    expect(screen.getByLabelText('Search fonts')).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Inter' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Georgia' })).toBeTruthy()
  })

  it('each option previews in its own font family', () => {
    setup({ selectedElements: [TEXT_EL] })
    fireEvent.click(screen.getByLabelText('Font family'))
    const georgia = screen.getByRole('option', { name: 'Georgia' }) as HTMLElement
    expect(georgia.style.fontFamily).toContain('Georgia')
  })

  it('filters the list by search query', () => {
    setup({ selectedElements: [TEXT_EL] })
    fireEvent.click(screen.getByLabelText('Font family'))
    fireEvent.change(screen.getByLabelText('Search fonts'), { target: { value: 'geor' } })
    expect(screen.getByRole('option', { name: 'Georgia' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Inter' })).toBeNull()
  })

  it('selecting a font fires fontFamily patch (no silent fallback)', () => {
    const { onSetAttrs } = setup({ selectedElements: [TEXT_EL] })
    fireEvent.click(screen.getByLabelText('Font family'))
    fireEvent.click(screen.getByRole('option', { name: 'Georgia' }))
    expect(onSetAttrs).toHaveBeenCalledWith('text-1', { fontFamily: 'Georgia' })
  })

  it('surfaces a current family that is not in the curated list', () => {
    setup({ selectedElements: [{ ...TEXT_EL, fontFamily: 'Comic Sans MS' }] })
    const trigger = screen.getByLabelText('Font family')
    expect(trigger.textContent).toContain('Comic Sans MS')
    fireEvent.click(trigger)
    expect(screen.getByRole('option', { name: 'Comic Sans MS' })).toBeTruthy()
  })
})

describe('ColorSwatch (swatch button + popover picker)', () => {
  it('renders a swatch button (no bare color input) until opened', () => {
    setup({ selectedElements: [TEXT_EL] })
    const swatch = screen.getByLabelText('Fill color')
    expect(swatch.tagName).toBe('BUTTON')
    expect(screen.queryByLabelText('Fill color picker')).toBeNull()
    fireEvent.click(swatch)
    expect(screen.getByLabelText('Fill color picker')).toBeTruthy()
  })

  it('committing a color fires the same fill patch contract', () => {
    const { onSetAttrs } = setup({ selectedElements: [TEXT_EL] })
    fireEvent.click(screen.getByLabelText('Fill color'))
    fireEvent.change(screen.getByLabelText('Fill color picker'), { target: { value: '#ff0000' } })
    expect(onSetAttrs).toHaveBeenCalledWith('text-1', { fill: '#ff0000' })
  })
})

describe('SelectControl (replaces native <select>)', () => {
  it('image fit is a popover dropdown that fires the fit patch', () => {
    const { onSetAttrs } = setup({ selectedElements: [IMAGE_EL] })
    const fitTrigger = within(screen.getByText('Fit').closest('label') as HTMLElement).getByRole('button')
    expect(fitTrigger.tagName).toBe('BUTTON')
    fireEvent.click(fitTrigger)
    fireEvent.click(screen.getByRole('option', { name: 'Contain' }))
    expect(onSetAttrs).toHaveBeenCalledWith('image-1', { fit: 'contain' })
  })

  it('page size preset is a popover dropdown that fires width/height', () => {
    const { onSetPageProps } = setup({ selectedElements: [] })
    const presetTrigger = within(screen.getByText('Preset').closest('label') as HTMLElement).getByRole('button')
    fireEvent.click(presetTrigger)
    fireEvent.click(screen.getByRole('option', { name: 'YouTube Thumbnail' }))
    expect(onSetPageProps).toHaveBeenCalledWith({ width: 1280, height: 720 })
  })
})
