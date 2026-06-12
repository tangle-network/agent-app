/**
 * Pure-function tests for the editor chrome helpers:
 * - Z-order index math (topIndex, indexForward, indexBackward, clampIndex)
 * - PagesStrip reorder boundary math
 * - flattenLayerTree visual ordering invariants (complements layer-tree.test.ts)
 *
 * Nothing here touches React, Konva, or a DOM.
 */

import { describe, expect, it } from 'vitest'
import {
  clampIndex,
  indexBackward,
  indexForward,
  topIndex,
} from '../../src/design-canvas-react/components/ruler-math'
import { flattenLayerTree } from '../../src/design-canvas-react/components/layer-tree'
import type { ScenePage } from '../../src/design-canvas/model'

// ---------------------------------------------------------------------------
// Z-order index math
// ---------------------------------------------------------------------------

describe('topIndex', () => {
  it('returns ownerLength - 1', () => {
    expect(topIndex(3)).toBe(2)
    expect(topIndex(1)).toBe(0)
  })

  it('returns 0 for single-element owner', () => {
    expect(topIndex(1)).toBe(0)
  })
})

describe('indexForward', () => {
  it('increments toward the top', () => {
    expect(indexForward(0, 5)).toBe(1)
    expect(indexForward(2, 5)).toBe(3)
  })

  it('clamps at the top (ownerLength - 1)', () => {
    expect(indexForward(4, 5)).toBe(4)
    expect(indexForward(5, 5)).toBe(4)
  })
})

describe('indexBackward', () => {
  it('decrements toward the bottom', () => {
    expect(indexBackward(3)).toBe(2)
    expect(indexBackward(1)).toBe(0)
  })

  it('clamps at 0', () => {
    expect(indexBackward(0)).toBe(0)
  })
})

describe('clampIndex', () => {
  it('returns the value unchanged when in range', () => {
    expect(clampIndex(2, 5)).toBe(2)
    expect(clampIndex(0, 5)).toBe(0)
    expect(clampIndex(4, 5)).toBe(4)
  })

  it('clamps negative values to 0', () => {
    expect(clampIndex(-1, 5)).toBe(0)
    expect(clampIndex(-100, 5)).toBe(0)
  })

  it('clamps values above ownerLength - 1', () => {
    expect(clampIndex(5, 5)).toBe(4)
    expect(clampIndex(99, 5)).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// Z-order round-trip: bring-to-front / send-to-back / forward / backward
// ---------------------------------------------------------------------------

describe('z-order direction math', () => {
  // Owner of 5 elements: indices 0 (bottom) … 4 (top)
  const ownerLength = 5

  it('bring-to-front always produces topIndex', () => {
    for (let current = 0; current < ownerLength; current++) {
      expect(topIndex(ownerLength)).toBe(ownerLength - 1)
    }
  })

  it('send-to-back always produces 0', () => {
    // send-to-back = explicit 0; clampIndex(0, n) must be 0
    expect(clampIndex(0, ownerLength)).toBe(0)
  })

  it('forward from bottom reaches second position', () => {
    expect(indexForward(0, ownerLength)).toBe(1)
  })

  it('backward from top reaches second-from-top', () => {
    expect(indexBackward(ownerLength - 1)).toBe(ownerLength - 2)
  })

  it('forward from top stays at top', () => {
    expect(indexForward(ownerLength - 1, ownerLength)).toBe(ownerLength - 1)
  })

  it('backward from bottom stays at bottom', () => {
    expect(indexBackward(0)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// PagesStrip reorder math — toIndex bounds
// ---------------------------------------------------------------------------

describe('page reorder index bounds', () => {
  // When a page is dragged, toIndex is the target position in the pages array.
  // Valid range: 0 … pages.length - 1. clampIndex provides this invariant.

  it('clamps toIndex within pages array bounds', () => {
    const pageCount = 4
    expect(clampIndex(-1, pageCount)).toBe(0)
    expect(clampIndex(0, pageCount)).toBe(0)
    expect(clampIndex(3, pageCount)).toBe(3)
    expect(clampIndex(4, pageCount)).toBe(3)
    expect(clampIndex(100, pageCount)).toBe(3)
  })

  it('single page: toIndex clamps to 0', () => {
    expect(clampIndex(0, 1)).toBe(0)
    expect(clampIndex(5, 1)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Layer tree: visual ordering invariants
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

const rect = (id: string) => ({
  id,
  kind: 'rect' as const,
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

describe('flattenLayerTree visual ordering invariants', () => {
  it('panel order is reverse of array z-order: last element is topmost panel row', () => {
    const page = makePage({ elements: [rect('a'), rect('b'), rect('c'), rect('d')] })
    const rows = flattenLayerTree(page)
    // Highest z-index (array tail) → first panel row
    expect(rows.map((r) => r.element.id)).toEqual(['d', 'c', 'b', 'a'])
  })

  it('ownerIndex of each row matches the element position in the source array', () => {
    // 3 elements: indices 0, 1, 2 — panel shows 2, 1, 0
    const page = makePage({ elements: [rect('x'), rect('y'), rect('z')] })
    const rows = flattenLayerTree(page)
    expect(rows[0]?.ownerIndex).toBe(2) // 'z' at array[2]
    expect(rows[1]?.ownerIndex).toBe(1) // 'y' at array[1]
    expect(rows[2]?.ownerIndex).toBe(0) // 'x' at array[0]
  })

  it('ownerLength equals the length of the array that contains the element', () => {
    const page = makePage({ elements: [rect('a'), rect('b'), rect('c')] })
    const rows = flattenLayerTree(page)
    for (const row of rows) {
      expect(row.ownerLength).toBe(3)
    }
  })

  it('group children appear after the group row with depth + 1', () => {
    const page = makePage({
      elements: [
        {
          id: 'g',
          kind: 'group' as const,
          name: 'G',
          x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true,
          children: [rect('c1'), rect('c2')],
        },
        rect('top'),
      ],
    })
    const rows = flattenLayerTree(page)
    // 'top' is above 'g' in z-order (index 1 vs 0), so panel: top, g, c2, c1
    expect(rows[0]?.element.id).toBe('top')
    expect(rows[1]?.element.id).toBe('g')
    expect(rows[1]?.depth).toBe(0)
    expect(rows[2]?.element.id).toBe('c2') // reversed: c2 over c1
    expect(rows[2]?.depth).toBe(1)
    expect(rows[3]?.element.id).toBe('c1')
    expect(rows[3]?.depth).toBe(1)
  })

  it('all rows for page-root elements have parentGroupId null', () => {
    const page = makePage({ elements: [rect('a'), rect('b')] })
    const rows = flattenLayerTree(page)
    for (const row of rows) {
      expect(row.parentGroupId).toBeNull()
    }
  })

  it('group children rows carry their parent group id', () => {
    const page = makePage({
      elements: [
        {
          id: 'grp',
          kind: 'group' as const,
          name: 'Grp',
          x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true,
          children: [rect('child')],
        },
      ],
    })
    const rows = flattenLayerTree(page)
    const childRow = rows.find((r) => r.element.id === 'child')
    expect(childRow?.parentGroupId).toBe('grp')
  })

  it('isGroup is true only for group-kind elements', () => {
    const page = makePage({
      elements: [
        rect('r'),
        {
          id: 'g',
          kind: 'group' as const,
          name: 'G',
          x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true,
          children: [],
        },
      ],
    })
    const rows = flattenLayerTree(page)
    const gRow = rows.find((r) => r.element.id === 'g')
    const rRow = rows.find((r) => r.element.id === 'r')
    expect(gRow?.isGroup).toBe(true)
    expect(rRow?.isGroup).toBe(false)
  })
})
