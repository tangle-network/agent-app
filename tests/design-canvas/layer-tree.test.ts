import { describe, expect, it } from 'vitest'
import { flattenLayerTree, LAYERS_PANEL_ROW_LIMIT } from '../../src/design-canvas-react/components/layer-tree'
import type { ScenePage } from '../../src/design-canvas/model'

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

describe('flattenLayerTree', () => {
  it('returns empty for a page with no elements', () => {
    expect(flattenLayerTree(makePage())).toEqual([])
  })

  it('reverses element order so highest z-index is first', () => {
    const page = makePage({
      elements: [
        { id: 'a', kind: 'rect', name: 'A', x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true, width: 10, height: 10, fill: '#000' },
        { id: 'b', kind: 'rect', name: 'B', x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true, width: 10, height: 10, fill: '#000' },
        { id: 'c', kind: 'rect', name: 'C', x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true, width: 10, height: 10, fill: '#000' },
      ],
    })
    const rows = flattenLayerTree(page)
    // Top element (index 2 in elements = 'c') should be first in the panel.
    expect(rows.map((r) => r.element.id)).toEqual(['c', 'b', 'a'])
  })

  it('records ownerIndex correctly', () => {
    const page = makePage({
      elements: [
        { id: 'a', kind: 'rect', name: 'A', x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true, width: 10, height: 10, fill: '#000' },
        { id: 'b', kind: 'rect', name: 'B', x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true, width: 10, height: 10, fill: '#000' },
      ],
    })
    const rows = flattenLayerTree(page)
    // Panel row 0 = element at index 1 (top z-order), row 1 = element at index 0.
    expect(rows[0]?.ownerIndex).toBe(1)
    expect(rows[1]?.ownerIndex).toBe(0)
  })

  it('expands groups and sets depth and parentGroupId correctly', () => {
    const page = makePage({
      elements: [
        {
          id: 'g',
          kind: 'group',
          name: 'G',
          x: 0,
          y: 0,
          rotation: 0,
          opacity: 1,
          locked: false,
          visible: true,
          children: [
            { id: 'child', kind: 'rect', name: 'Child', x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true, width: 10, height: 10, fill: '#000' },
          ],
        },
      ],
    })
    const rows = flattenLayerTree(page)
    // Row 0: group at depth 0
    expect(rows[0]?.element.id).toBe('g')
    expect(rows[0]?.depth).toBe(0)
    expect(rows[0]?.isGroup).toBe(true)
    expect(rows[0]?.parentGroupId).toBeNull()
    // Row 1: child at depth 1, parentGroupId = 'g'
    expect(rows[1]?.element.id).toBe('child')
    expect(rows[1]?.depth).toBe(1)
    expect(rows[1]?.parentGroupId).toBe('g')
  })

  it('handles nested groups to arbitrary depth', () => {
    const page = makePage({
      elements: [
        {
          id: 'outer',
          kind: 'group',
          name: 'Outer',
          x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true,
          children: [
            {
              id: 'inner',
              kind: 'group',
              name: 'Inner',
              x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true,
              children: [
                { id: 'leaf', kind: 'ellipse', name: 'Leaf', x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true, width: 5, height: 5, fill: '#f00' },
              ],
            },
          ],
        },
      ],
    })
    const rows = flattenLayerTree(page)
    expect(rows[0]?.element.id).toBe('outer')
    expect(rows[0]?.depth).toBe(0)
    expect(rows[1]?.element.id).toBe('inner')
    expect(rows[1]?.depth).toBe(1)
    expect(rows[2]?.element.id).toBe('leaf')
    expect(rows[2]?.depth).toBe(2)
  })

  it('exposes LAYERS_PANEL_ROW_LIMIT as 500', () => {
    expect(LAYERS_PANEL_ROW_LIMIT).toBe(500)
  })
})
