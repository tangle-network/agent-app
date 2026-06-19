// @vitest-environment jsdom
/**
 * Canvas chrome accessibility + the shared icon-button contract:
 * - IconButton / the shared BTN class consts carry a keyboard-only focus ring.
 * - Toolbar toggles expose state via aria-pressed / aria-checked, not class alone.
 * - LayersPanel and PagesStrip drag-reorder emit the host reorder callback with
 *   the correct (elementId|pageId, toIndex) so the host can build the
 *   reorder_element / reorder_page command.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { IconButton, BTN, BTN_ACTIVE, BTN_SM } from '../../src/design-canvas-react/components/icon-button'
import { Toolbar } from '../../src/design-canvas-react/components/Toolbar'
import { LayersPanel } from '../../src/design-canvas-react/components/LayersPanel'
import { PagesStrip } from '../../src/design-canvas-react/components/PagesStrip'
import type { ScenePage, SceneElement, TextElement } from '../../src/design-canvas/model'

afterEach(cleanup)

// ---------------------------------------------------------------------------
// Shared icon-button focus ring
// ---------------------------------------------------------------------------

describe('shared icon-button contract', () => {
  it('exposes a keyboard-only (focus-visible) ring on every variant', () => {
    for (const cls of [BTN, BTN_ACTIVE, BTN_SM]) {
      expect(cls).toContain('focus-visible:ring-2')
      expect(cls).toContain('focus-visible:ring-[hsl(var(--ring))]')
      // never a permanent (non focus-visible) ring
      expect(cls).not.toMatch(/(^|\s)ring-2/)
    }
  })

  it('IconButton renders the focus-visible ring class and is a real button', () => {
    render(createElement(IconButton, { 'aria-label': 'Test action' }))
    const btn = screen.getByLabelText('Test action')
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.getAttribute('type')).toBe('button')
    expect(btn.className).toContain('focus-visible:ring-2')
  })

  it('IconButton active variant uses the brand-colored class', () => {
    render(createElement(IconButton, { 'aria-label': 'Active action', active: true }))
    expect(screen.getByLabelText('Active action').className).toContain('border-[var(--brand-primary)]')
  })

  it('IconButton size=sm is 24px (h-6), default is 28px (h-7)', () => {
    render(createElement(IconButton, { 'aria-label': 'Sm', size: 'sm' }))
    render(createElement(IconButton, { 'aria-label': 'Md' }))
    expect(screen.getByLabelText('Sm').className).toContain('h-6')
    expect(screen.getByLabelText('Md').className).toContain('h-7')
  })
})

// ---------------------------------------------------------------------------
// Scene fixtures
// ---------------------------------------------------------------------------

function makePage(overrides: Partial<ScenePage> = {}): ScenePage {
  return {
    id: 'page-1',
    name: 'Page',
    width: 1080,
    height: 1080,
    background: '#ffffff',
    bleed: null,
    guides: { vertical: [], horizontal: [] },
    elements: [],
    ...overrides,
  }
}

const rect = (id: string): SceneElement => ({
  id,
  kind: 'rect',
  name: id,
  x: 0,
  y: 0,
  rotation: 0,
  opacity: 1,
  locked: false,
  visible: true,
  width: 10,
  height: 10,
  fill: '#000',
})

const text = (id: string, over: Partial<TextElement> = {}): TextElement => ({
  id,
  kind: 'text',
  name: id,
  x: 0,
  y: 0,
  rotation: 0,
  opacity: 1,
  locked: false,
  visible: true,
  width: 100,
  text: 'Hello',
  fontFamily: 'Inter',
  fontSize: 16,
  fontStyle: 'normal',
  fill: '#000',
  align: 'left',
  lineHeight: 1.2,
  letterSpacing: 0,
  ...over,
})

function toolbarProps(over: Partial<Parameters<typeof Toolbar>[0]> = {}): Parameters<typeof Toolbar>[0] {
  return {
    page: makePage(),
    selectedElements: [],
    canWrite: true,
    canUndo: true,
    canRedo: true,
    gridEnabled: false,
    snapEnabled: false,
    showRulers: false,
    showBleed: false,
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
    ...over,
  }
}

// ---------------------------------------------------------------------------
// Toolbar aria-pressed / aria-checked on stateful toggles
// ---------------------------------------------------------------------------

describe('Toolbar toggle a11y state', () => {
  it('Lock toggle exposes aria-pressed reflecting locked state', () => {
    render(createElement(Toolbar, toolbarProps({ selectedElements: [{ ...rect('r'), locked: true }] })))
    expect(screen.getByLabelText('Unlock element').getAttribute('aria-pressed')).toBe('true')
  })

  it('Lock toggle of an unlocked element is aria-pressed=false', () => {
    render(createElement(Toolbar, toolbarProps({ selectedElements: [rect('r')] })))
    expect(screen.getByLabelText('Lock element').getAttribute('aria-pressed')).toBe('false')
  })

  it('Bold/Italic toggles expose aria-pressed from fontStyle', () => {
    render(createElement(Toolbar, toolbarProps({ selectedElements: [text('t', { fontStyle: 'bold' })] })))
    expect(screen.getByLabelText('Bold').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('Italic').getAttribute('aria-pressed')).toBe('false')
  })

  it('Align controls are a radiogroup with aria-checked on the active option', () => {
    render(createElement(Toolbar, toolbarProps({ selectedElements: [text('t', { align: 'center' })] })))
    expect(screen.getByRole('radiogroup', { name: 'Text alignment' })).toBeTruthy()
    expect(screen.getByLabelText('Align center').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByLabelText('Align left').getAttribute('aria-checked')).toBe('false')
  })

  it('Slot toggle exposes aria-pressed reflecting a bound slot', () => {
    render(createElement(Toolbar, toolbarProps({ selectedElements: [{ ...rect('r'), slot: 'hero' }] })))
    expect(screen.getByLabelText('Slot: hero').getAttribute('aria-pressed')).toBe('true')
  })

  it('the pre-existing view toggles still carry aria-pressed', () => {
    render(createElement(Toolbar, toolbarProps({ gridEnabled: true })))
    expect(screen.getByLabelText('Toggle grid').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('Toggle snap').getAttribute('aria-pressed')).toBe('false')
  })
})

// ---------------------------------------------------------------------------
// LayersPanel drag-reorder emits onReorder(elementId, toIndex)
// ---------------------------------------------------------------------------

describe('LayersPanel drag reorder', () => {
  it('dropping row A onto row B emits onReorder(A.id, B.ownerIndex)', () => {
    const onReorder = vi.fn()
    // array z-order: a(0) b(1) c(2); panel top→bottom: c, b, a
    render(
      createElement(LayersPanel, {
        page: makePage({ elements: [rect('a'), rect('b'), rect('c')] }),
        selectedElementIds: [],
        canWrite: true,
        onSetAttrs: vi.fn(),
        onReorder,
        onSelect: vi.fn(),
      }),
    )
    const rowC = document.querySelector('[data-layer-row="c"]')!
    const rowA = document.querySelector('[data-layer-row="a"]')!
    fireEvent.dragStart(rowC)
    fireEvent.dragOver(rowA)
    fireEvent.drop(rowA)
    // 'a' sits at ownerIndex 0 in the source array → drop target index 0
    expect(onReorder).toHaveBeenCalledWith('c', 0)
  })

  it('dropping a row on itself does not emit', () => {
    const onReorder = vi.fn()
    render(
      createElement(LayersPanel, {
        page: makePage({ elements: [rect('a'), rect('b')] }),
        selectedElementIds: [],
        canWrite: true,
        onSetAttrs: vi.fn(),
        onReorder,
        onSelect: vi.fn(),
      }),
    )
    const rowA = document.querySelector('[data-layer-row="a"]')!
    fireEvent.dragStart(rowA)
    fireEvent.drop(rowA)
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('hover-reveal toggles use group-hover, not the brittle [.flex:hover] fallback', () => {
    render(
      createElement(LayersPanel, {
        page: makePage({ elements: [rect('a')] }),
        selectedElementIds: [],
        canWrite: true,
        onSetAttrs: vi.fn(),
        onReorder: vi.fn(),
        onSelect: vi.fn(),
      }),
    )
    const row = document.querySelector('[data-layer-row="a"]')!
    expect(row.className).toContain('group')
    const eye = screen.getByLabelText('Hide element')
    expect(eye.className).toContain('group-hover:opacity-100')
    expect(eye.className).not.toContain('[.flex:hover')
  })
})

// ---------------------------------------------------------------------------
// PagesStrip drag-reorder emits onReorderPage(pageId, toIndex)
// ---------------------------------------------------------------------------

describe('PagesStrip drag reorder', () => {
  const renderThumbnail = vi.fn().mockResolvedValue(null)

  it('dropping page 0 onto page 2 emits onReorderPage(page0.id, 2)', () => {
    const onReorderPage = vi.fn()
    render(
      createElement(PagesStrip, {
        pages: [makePage({ id: 'p0' }), makePage({ id: 'p1' }), makePage({ id: 'p2' })],
        activePageId: 'p0',
        canWrite: true,
        renderThumbnail,
        onSelectPage: vi.fn(),
        onAddPage: vi.fn(),
        onDuplicatePage: vi.fn(),
        onDeletePage: vi.fn(),
        onReorderPage,
      }),
    )
    const first = screen.getByLabelText(/^Page 1:/)
    const third = screen.getByLabelText(/^Page 3:/)
    fireEvent.dragStart(first)
    fireEvent.dragOver(third)
    fireEvent.drop(third)
    expect(onReorderPage).toHaveBeenCalledWith('p0', 2)
  })

  it('dropping a page on itself does not emit', () => {
    const onReorderPage = vi.fn()
    render(
      createElement(PagesStrip, {
        pages: [makePage({ id: 'p0' }), makePage({ id: 'p1' })],
        activePageId: 'p0',
        canWrite: true,
        renderThumbnail,
        onSelectPage: vi.fn(),
        onAddPage: vi.fn(),
        onDuplicatePage: vi.fn(),
        onDeletePage: vi.fn(),
        onReorderPage,
      }),
    )
    const first = screen.getByLabelText(/^Page 1:/)
    fireEvent.dragStart(first)
    fireEvent.drop(first)
    expect(onReorderPage).not.toHaveBeenCalled()
  })
})
