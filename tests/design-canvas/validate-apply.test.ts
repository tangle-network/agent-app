/**
 * Tests for design-canvas validate.ts and apply.ts.
 *
 * Coverage strategy:
 *  - validate: every op type happy path + every documented rejection
 *  - apply: pure document mutations per op type
 *  - group/ungroup: round-trip preserving absolute positions (including rotated children)
 *  - duplicate_page: id re-mint uniqueness across pages
 *  - apply_data: slot typing (text/image/video/rect/ellipse/line/group)
 *  - storeApplyScenePlan: happy path + stale-rev retry + double-stale throw
 */

import { describe, it, expect, vi } from 'vitest'
import {
  applySceneOperation,
  applySceneOperations,
  storeApplyScenePlan,
} from '../../src/design-canvas/apply'
import type { ApplySceneOptions } from '../../src/design-canvas/apply'
import {
  validateSceneOperations,
  validateSlotValue,
} from '../../src/design-canvas/validate'
import {
  createEmptyDocument,
  elementAabb,
} from '../../src/design-canvas/model'
import type {
  EllipseElement,
  GroupElement,
  ImageElement,
  LineElement,
  RectElement,
  SceneDocument,
  SceneElement,
  TextElement,
  VideoElement,
} from '../../src/design-canvas/model'
import type { SceneStore } from '../../src/design-canvas/store'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAGE_ID = 'page-1'

function baseDoc(elements: SceneElement[] = []): SceneDocument {
  const doc = createEmptyDocument('Test', { width: 1000, height: 800 })
  doc.pages[0]!.elements = elements
  return doc
}

function makeRect(id: string, x = 0, y = 0, w = 100, h = 50): RectElement {
  return {
    id, kind: 'rect', name: id,
    x, y, rotation: 0, opacity: 1, locked: false, visible: true,
    width: w, height: h, fill: '#ff0000',
  }
}

function makeEllipse(id: string): EllipseElement {
  return {
    id, kind: 'ellipse', name: id,
    x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true,
    width: 80, height: 60, fill: '#00ff00',
  }
}

function makeLine(id: string): LineElement {
  return {
    id, kind: 'line', name: id,
    x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true,
    points: [0, 0, 100, 100], stroke: '#000000', strokeWidth: 2,
  }
}

function makeText(id: string): TextElement {
  return {
    id, kind: 'text', name: id,
    x: 10, y: 10, rotation: 0, opacity: 1, locked: false, visible: true,
    text: 'Hello', width: 200, fontFamily: 'Arial', fontSize: 16,
    fontStyle: 'normal', fill: '#333333', align: 'left', lineHeight: 1.2, letterSpacing: 0,
  }
}

function makeImage(id: string): ImageElement {
  return {
    id, kind: 'image', name: id,
    x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true,
    width: 400, height: 300, src: 'https://cdn.example/img.png', fit: 'cover',
  }
}

function makeVideo(id: string): VideoElement {
  return {
    id, kind: 'video', name: id,
    x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true,
    width: 400, height: 300, src: 'https://cdn.example/vid.mp4',
  }
}

function makeGroup(id: string, children: SceneElement[]): GroupElement {
  return {
    id, kind: 'group', name: id,
    x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true,
    children,
  }
}

let mintCounter = 0
function mintId(): string {
  return `minted-${(mintCounter += 1)}`
}
function resetMintCounter(): void {
  mintCounter = 0
}

const DEFAULT_OPTS: ApplySceneOptions = { mintId }

// ---------------------------------------------------------------------------
// validateSceneOperations — per-op-type happy paths
// ---------------------------------------------------------------------------

describe('validateSceneOperations — happy paths', () => {
  it('add_element rect', () => {
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'add_element', pageId: PAGE_ID, element: makeRect('r1') }])
    ).not.toThrow()
  })

  it('add_element ellipse', () => {
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'add_element', pageId: PAGE_ID, element: makeEllipse('e1') }])
    ).not.toThrow()
  })

  it('add_element line', () => {
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'add_element', pageId: PAGE_ID, element: makeLine('l1') }])
    ).not.toThrow()
  })

  it('add_element text', () => {
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'add_element', pageId: PAGE_ID, element: makeText('t1') }])
    ).not.toThrow()
  })

  it('add_element image', () => {
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'add_element', pageId: PAGE_ID, element: makeImage('img1') }])
    ).not.toThrow()
  })

  it('add_element video', () => {
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'add_element', pageId: PAGE_ID, element: makeVideo('v1') }])
    ).not.toThrow()
  })

  it('set_attrs on unlocked element', () => {
    const doc = baseDoc([makeRect('r1')])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'set_attrs', pageId: PAGE_ID, elementId: 'r1', attrs: { x: 50, fill: '#0000ff' } }])
    ).not.toThrow()
  })

  it('set_attrs unlock-only patch on locked element', () => {
    const locked = { ...makeRect('r1'), locked: true }
    const doc = baseDoc([locked])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'set_attrs', pageId: PAGE_ID, elementId: 'r1', attrs: { locked: false } }])
    ).not.toThrow()
  })

  it('reorder_element', () => {
    const doc = baseDoc([makeRect('r1'), makeRect('r2')])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'reorder_element', pageId: PAGE_ID, elementId: 'r1', toIndex: 1 }])
    ).not.toThrow()
  })

  it('delete_element', () => {
    const doc = baseDoc([makeRect('r1')])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'delete_element', pageId: PAGE_ID, elementId: 'r1' }])
    ).not.toThrow()
  })

  it('group_elements', () => {
    const doc = baseDoc([makeRect('r1'), makeRect('r2')])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'group_elements', pageId: PAGE_ID, elementIds: ['r1', 'r2'], groupId: 'g1' }])
    ).not.toThrow()
  })

  it('ungroup_element', () => {
    const doc = baseDoc([makeGroup('g1', [makeRect('r1')])])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'ungroup_element', pageId: PAGE_ID, groupId: 'g1' }])
    ).not.toThrow()
  })

  it('add_page', () => {
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'add_page', pageId: 'p2' }])
    ).not.toThrow()
  })

  it('duplicate_page', () => {
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'duplicate_page', sourcePageId: PAGE_ID, pageId: 'p2' }])
    ).not.toThrow()
  })

  it('delete_page with multiple pages', () => {
    const doc = applySceneOperation(baseDoc(), { type: 'add_page', pageId: 'p2' })
    expect(() =>
      validateSceneOperations(doc, [{ type: 'delete_page', pageId: 'p2' }])
    ).not.toThrow()
  })

  it('reorder_page', () => {
    const doc = applySceneOperation(baseDoc(), { type: 'add_page', pageId: 'p2' })
    expect(() =>
      validateSceneOperations(doc, [{ type: 'reorder_page', pageId: 'p2', toIndex: 0 }])
    ).not.toThrow()
  })

  it('set_page_props', () => {
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'set_page_props', pageId: PAGE_ID, name: 'Renamed', width: 720, height: 1280 }])
    ).not.toThrow()
  })

  it('set_page_guides', () => {
    expect(() =>
      validateSceneOperations(baseDoc(), [{
        type: 'set_page_guides', pageId: PAGE_ID,
        guides: { vertical: [100, 200], horizontal: [50] },
      }])
    ).not.toThrow()
  })

  it('bind_slot', () => {
    const doc = baseDoc([makeRect('r1')])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'bind_slot', pageId: PAGE_ID, elementId: 'r1', slot: 'bg' }])
    ).not.toThrow()
  })

  it('apply_data text slot', () => {
    const el = { ...makeText('t1'), slot: 'headline' }
    const doc = baseDoc([el])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'apply_data', bindings: { headline: 'New text' } }])
    ).not.toThrow()
  })

  it('set_document_title', () => {
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'set_document_title', title: 'My Campaign' }])
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// validateSceneOperations — rejections
// ---------------------------------------------------------------------------

describe('validateSceneOperations — rejections', () => {
  it('error message includes operation index and type', () => {
    expect(() =>
      validateSceneOperations(baseDoc(), [
        { type: 'set_attrs', pageId: PAGE_ID, elementId: 'nonexistent', attrs: {} },
      ])
    ).toThrow(/operation 1 \(set_attrs\)/)
  })

  // add_element rejections
  it('add_element: duplicate id document-wide', () => {
    const doc = baseDoc([makeRect('r1')])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'add_element', pageId: PAGE_ID, element: makeRect('r1') }])
    ).toThrow(/id "r1"/)
  })

  it('add_element: parentGroupId that is not a group', () => {
    const doc = baseDoc([makeRect('r1'), makeRect('r2')])
    expect(() =>
      validateSceneOperations(doc, [{
        type: 'add_element', pageId: PAGE_ID,
        element: makeRect('r3'), parentGroupId: 'r1',
      }])
    ).toThrow(/not a group/)
  })

  it('add_element: index out of range', () => {
    const doc = baseDoc([makeRect('r1')])
    expect(() =>
      validateSceneOperations(doc, [{
        type: 'add_element', pageId: PAGE_ID,
        element: makeRect('r2'), index: 5,
      }])
    ).toThrow(/out of range/)
  })

  it('add_element: foreign attr (fontSize on rect)', () => {
    const el = { ...makeRect('r1'), fontSize: 24 } as unknown as SceneElement
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'add_element', pageId: PAGE_ID, element: el }])
    ).toThrow(/not valid for a rect/)
  })

  it('add_element: missing required attr (fill on rect)', () => {
    const el = { id: 'r1', kind: 'rect' as const, name: 'r', x: 0, y: 0, rotation: 0, opacity: 1, locked: false, visible: true, width: 100, height: 50 } as unknown as SceneElement
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'add_element', pageId: PAGE_ID, element: el }])
    ).toThrow(/fill is required/)
  })

  it('add_element: invalid color', () => {
    const el = { ...makeRect('r1'), fill: 'notacolor' }
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'add_element', pageId: PAGE_ID, element: el }])
    ).toThrow(/color/)
  })

  it('add_element: opacity out of range', () => {
    const el = { ...makeRect('r1'), opacity: 1.5 }
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'add_element', pageId: PAGE_ID, element: el }])
    ).toThrow(/opacity/)
  })

  it('add_element: negative width', () => {
    const el = { ...makeRect('r1'), width: -10 }
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'add_element', pageId: PAGE_ID, element: el }])
    ).toThrow(/width/)
  })

  it('add_element: line points length < 4', () => {
    const el = { ...makeLine('l1'), points: [0, 0] }
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'add_element', pageId: PAGE_ID, element: el }])
    ).toThrow(/points/)
  })

  it('add_element: line points odd length', () => {
    const el = { ...makeLine('l1'), points: [0, 0, 100] }
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'add_element', pageId: PAGE_ID, element: el }])
    ).toThrow(/points/)
  })

  it('add_element: invalid lineHeight (zero)', () => {
    const el = { ...makeText('t1'), lineHeight: 0 }
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'add_element', pageId: PAGE_ID, element: el }])
    ).toThrow(/lineHeight/)
  })

  it('add_element: invalid fontStyle', () => {
    const el = { ...makeText('t1'), fontStyle: 'heavy' as TextElement['fontStyle'] }
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'add_element', pageId: PAGE_ID, element: el }])
    ).toThrow(/fontStyle/)
  })

  it('add_element: invalid align', () => {
    const el = { ...makeText('t1'), align: 'justify' as TextElement['align'] }
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'add_element', pageId: PAGE_ID, element: el }])
    ).toThrow(/align/)
  })

  it('add_element: invalid media src (data URI)', () => {
    const el = { ...makeImage('img1'), src: 'data:image/png;base64,abc' }
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'add_element', pageId: PAGE_ID, element: el }])
    ).toThrow(/http/)
  })

  it('add_element: invalid fit', () => {
    const el = { ...makeImage('img1'), fit: 'stretch' as ImageElement['fit'] }
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'add_element', pageId: PAGE_ID, element: el }])
    ).toThrow(/fit/)
  })

  it('add_element: text foreignattr (cornerRadius on text)', () => {
    const el = { ...makeText('t1'), cornerRadius: 4 } as unknown as SceneElement
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'add_element', pageId: PAGE_ID, element: el }])
    ).toThrow(/not valid for a text/)
  })

  // set_attrs rejections
  it('set_attrs: locked element (non-unlock patch) rejected', () => {
    const locked = { ...makeRect('r1'), locked: true }
    const doc = baseDoc([locked])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'set_attrs', pageId: PAGE_ID, elementId: 'r1', attrs: { x: 50 } }])
    ).toThrow(/locked/)
  })

  it('set_attrs: foreign attr for element kind (fontSize on rect)', () => {
    const doc = baseDoc([makeRect('r1')])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'set_attrs', pageId: PAGE_ID, elementId: 'r1', attrs: { fontSize: 24 } as never }])
    ).toThrow(/not valid for a rect/)
  })

  it('set_attrs: invalid stroke color', () => {
    const doc = baseDoc([makeRect('r1')])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'set_attrs', pageId: PAGE_ID, elementId: 'r1', attrs: { stroke: 'badcolor' } }])
    ).toThrow(/color/)
  })

  // reorder_element rejections
  it('reorder_element: locked element', () => {
    const locked = { ...makeRect('r1'), locked: true }
    const doc = baseDoc([locked, makeRect('r2')])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'reorder_element', pageId: PAGE_ID, elementId: 'r1', toIndex: 1 }])
    ).toThrow(/locked/)
  })

  it('reorder_element: toIndex out of range', () => {
    const doc = baseDoc([makeRect('r1'), makeRect('r2')])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'reorder_element', pageId: PAGE_ID, elementId: 'r1', toIndex: 5 }])
    ).toThrow(/out of range/)
  })

  // delete_element rejections
  it('delete_element: locked element', () => {
    const locked = { ...makeRect('r1'), locked: true }
    const doc = baseDoc([locked])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'delete_element', pageId: PAGE_ID, elementId: 'r1' }])
    ).toThrow(/locked/)
  })

  // group_elements rejections
  it('group_elements: fewer than 2 ids', () => {
    const doc = baseDoc([makeRect('r1')])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'group_elements', pageId: PAGE_ID, elementIds: ['r1'], groupId: 'g1' }])
    ).toThrow(/≥ 2/)
  })

  it('group_elements: non-sibling elements', () => {
    const inner = makeRect('r1')
    const group = makeGroup('g1', [inner])
    const outer = makeRect('r2')
    const doc = baseDoc([group, outer])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'group_elements', pageId: PAGE_ID, elementIds: ['r1', 'r2'], groupId: 'g2' }])
    ).toThrow(/sibling/)
  })

  it('group_elements: locked member', () => {
    const locked = { ...makeRect('r1'), locked: true }
    const doc = baseDoc([locked, makeRect('r2')])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'group_elements', pageId: PAGE_ID, elementIds: ['r1', 'r2'], groupId: 'g1' }])
    ).toThrow(/locked/)
  })

  it('group_elements: duplicate groupId', () => {
    const doc = baseDoc([makeRect('r1'), makeRect('r2'), makeGroup('g1', [])])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'group_elements', pageId: PAGE_ID, elementIds: ['r1', 'r2'], groupId: 'g1' }])
    ).toThrow(/id "g1"/)
  })

  // ungroup_element rejections
  it('ungroup_element: target is not a group', () => {
    const doc = baseDoc([makeRect('r1')])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'ungroup_element', pageId: PAGE_ID, groupId: 'r1' }])
    ).toThrow(/not a group/)
  })

  // delete_page rejections
  it('delete_page: last remaining page', () => {
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'delete_page', pageId: PAGE_ID }])
    ).toThrow(/last/)
  })

  // reorder_page rejections
  it('reorder_page: toIndex out of range', () => {
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'reorder_page', pageId: PAGE_ID, toIndex: 5 }])
    ).toThrow(/out of range/)
  })

  // set_page_props rejections
  it('set_page_props: negative width', () => {
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'set_page_props', pageId: PAGE_ID, width: -1 }])
    ).toThrow(/width/)
  })

  it('set_page_props: invalid background color', () => {
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'set_page_props', pageId: PAGE_ID, background: 'bad' }])
    ).toThrow(/color/)
  })

  it('set_page_props: bleed with negative side', () => {
    expect(() =>
      validateSceneOperations(baseDoc(), [{
        type: 'set_page_props', pageId: PAGE_ID,
        bleed: { top: -1, right: 0, bottom: 0, left: 0 },
      }])
    ).toThrow(/bleed/)
  })

  // set_page_guides rejections
  it('set_page_guides: non-finite position', () => {
    expect(() =>
      validateSceneOperations(baseDoc(), [{
        type: 'set_page_guides', pageId: PAGE_ID,
        guides: { vertical: [Infinity], horizontal: [] },
      }])
    ).toThrow(/finite/)
  })

  // bind_slot rejections
  it('bind_slot: slot already bound to another element', () => {
    const el1 = { ...makeRect('r1'), slot: 'bg' }
    const el2 = makeRect('r2')
    const doc = baseDoc([el1, el2])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'bind_slot', pageId: PAGE_ID, elementId: 'r2', slot: 'bg' }])
    ).toThrow(/slot "bg"/)
  })

  // apply_data rejections
  it('apply_data: unknown slot name', () => {
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'apply_data', bindings: { missing: 'val' } }])
    ).toThrow(/slot "missing"/)
  })

  it('apply_data: image slot with non-media-src value', () => {
    const el = { ...makeImage('img1'), slot: 'hero' }
    const doc = baseDoc([el])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'apply_data', bindings: { hero: 'not-a-url' } }])
    ).toThrow(/http/)
  })

  it('apply_data: rect slot with non-color value', () => {
    const el = { ...makeRect('r1'), slot: 'bg' }
    const doc = baseDoc([el])
    expect(() =>
      validateSceneOperations(doc, [{ type: 'apply_data', bindings: { bg: 'not-a-color' } }])
    ).toThrow(/color/)
  })

  // set_document_title rejections
  it('set_document_title: empty title', () => {
    expect(() =>
      validateSceneOperations(baseDoc(), [{ type: 'set_document_title', title: '   ' }])
    ).toThrow(/non-empty/)
  })
})

// ---------------------------------------------------------------------------
// validateSlotValue — slot typing contract
// ---------------------------------------------------------------------------

describe('validateSlotValue', () => {
  it('text accepts any string', () => {
    expect(() => validateSlotValue('s', 'text', 'any string at all')).not.toThrow()
    expect(() => validateSlotValue('s', 'text', '')).not.toThrow()
  })

  it('image requires http(s) URL', () => {
    expect(() => validateSlotValue('s', 'image', 'https://example.com/img.png')).not.toThrow()
    expect(() => validateSlotValue('s', 'image', '/api/assets/img.png')).not.toThrow()
    expect(() => validateSlotValue('s', 'image', 'blob:local')).toThrow(/http/)
  })

  it('video requires http(s) URL', () => {
    expect(() => validateSlotValue('s', 'video', 'https://cdn.example/v.mp4')).not.toThrow()
    expect(() => validateSlotValue('s', 'video', 'file:///local.mp4')).toThrow(/http/)
  })

  it('rect requires a color', () => {
    expect(() => validateSlotValue('s', 'rect', '#ff0000')).not.toThrow()
    expect(() => validateSlotValue('s', 'rect', 'rgba(0,0,0,0.5)')).not.toThrow()
    expect(() => validateSlotValue('s', 'rect', 'https://example.com')).toThrow(/color/)
  })

  it('ellipse requires a color', () => {
    expect(() => validateSlotValue('s', 'ellipse', 'transparent')).not.toThrow()
    expect(() => validateSlotValue('s', 'ellipse', 'bad')).toThrow(/color/)
  })

  it('line requires a color (stroke recolor)', () => {
    expect(() => validateSlotValue('s', 'line', '#000')).not.toThrow()
    expect(() => validateSlotValue('s', 'line', 'nope')).toThrow(/color/)
  })

  it('group requires a color (propagated to children)', () => {
    expect(() => validateSlotValue('s', 'group', '#ffffff')).not.toThrow()
    expect(() => validateSlotValue('s', 'group', 'bad')).toThrow(/color/)
  })
})

// ---------------------------------------------------------------------------
// applySceneOperation / applySceneOperations — per-op-type happy paths
// ---------------------------------------------------------------------------

describe('applySceneOperation — add_element', () => {
  it('appends to page root when no index or parentGroupId', () => {
    const doc = baseDoc([makeRect('r1')])
    const result = applySceneOperation(doc, { type: 'add_element', pageId: PAGE_ID, element: makeRect('r2') })
    expect(result.pages[0]!.elements).toHaveLength(2)
    expect(result.pages[0]!.elements[1]!.id).toBe('r2')
  })

  it('inserts at explicit index', () => {
    const doc = baseDoc([makeRect('r1'), makeRect('r3')])
    const result = applySceneOperation(doc, {
      type: 'add_element', pageId: PAGE_ID,
      element: makeRect('r2'), index: 1,
    })
    const ids = result.pages[0]!.elements.map((e) => e.id)
    expect(ids).toEqual(['r1', 'r2', 'r3'])
  })

  it('inserts into group children', () => {
    const doc = baseDoc([makeGroup('g1', [])])
    const result = applySceneOperation(doc, {
      type: 'add_element', pageId: PAGE_ID,
      element: makeRect('r1'), parentGroupId: 'g1',
    })
    const group = result.pages[0]!.elements[0] as GroupElement
    expect(group.children).toHaveLength(1)
    expect(group.children[0]!.id).toBe('r1')
  })

  it('does not mutate original document', () => {
    const doc = baseDoc([makeRect('r1')])
    applySceneOperation(doc, { type: 'add_element', pageId: PAGE_ID, element: makeRect('r2') })
    expect(doc.pages[0]!.elements).toHaveLength(1)
  })
})

describe('applySceneOperation — set_attrs', () => {
  it('merges patch into existing element', () => {
    const doc = baseDoc([makeRect('r1', 0, 0)])
    const result = applySceneOperation(doc, {
      type: 'set_attrs', pageId: PAGE_ID, elementId: 'r1',
      attrs: { x: 99, fill: '#0000ff' },
    })
    const el = result.pages[0]!.elements[0] as RectElement
    expect(el.x).toBe(99)
    expect(el.fill).toBe('#0000ff')
  })

  it('preserves unpatched attrs', () => {
    const doc = baseDoc([makeRect('r1', 10, 20)])
    const result = applySceneOperation(doc, {
      type: 'set_attrs', pageId: PAGE_ID, elementId: 'r1',
      attrs: { x: 50 },
    })
    const el = result.pages[0]!.elements[0] as RectElement
    expect(el.y).toBe(20)
    expect(el.fill).toBe('#ff0000')
  })
})

describe('applySceneOperation — reorder_element', () => {
  it('moves element to new index', () => {
    const doc = baseDoc([makeRect('r1'), makeRect('r2'), makeRect('r3')])
    const result = applySceneOperation(doc, {
      type: 'reorder_element', pageId: PAGE_ID, elementId: 'r3', toIndex: 0,
    })
    const ids = result.pages[0]!.elements.map((e) => e.id)
    expect(ids).toEqual(['r3', 'r1', 'r2'])
  })
})

describe('applySceneOperation — delete_element', () => {
  it('removes element from page', () => {
    const doc = baseDoc([makeRect('r1'), makeRect('r2')])
    const result = applySceneOperation(doc, { type: 'delete_element', pageId: PAGE_ID, elementId: 'r1' })
    const ids = result.pages[0]!.elements.map((e) => e.id)
    expect(ids).toEqual(['r2'])
  })
})

// ---------------------------------------------------------------------------
// group_elements + ungroup_element — round-trip preserving absolute positions
// ---------------------------------------------------------------------------

describe('group_elements / ungroup_element', () => {
  it('group computes origin as min AABB corner of members', () => {
    const doc = baseDoc([makeRect('r1', 20, 30, 100, 50), makeRect('r2', 100, 80, 80, 40)])
    const result = applySceneOperation(doc, {
      type: 'group_elements', pageId: PAGE_ID, elementIds: ['r1', 'r2'], groupId: 'g1',
    })
    const group = result.pages[0]!.elements[0] as GroupElement
    expect(group.x).toBe(20)
    expect(group.y).toBe(30)
  })

  it('children rebased to group-local space', () => {
    const doc = baseDoc([makeRect('r1', 20, 30), makeRect('r2', 100, 80)])
    const grouped = applySceneOperation(doc, {
      type: 'group_elements', pageId: PAGE_ID, elementIds: ['r1', 'r2'], groupId: 'g1',
    })
    const group = grouped.pages[0]!.elements[0] as GroupElement
    // r1: group-local = (20-20, 30-30) = (0, 0)
    const c1 = group.children.find((c) => c.id === 'r1')!
    expect(c1.x).toBe(0)
    expect(c1.y).toBe(0)
    // r2: group-local = (100-20, 80-30) = (80, 50)
    const c2 = group.children.find((c) => c.id === 'r2')!
    expect(c2.x).toBe(80)
    expect(c2.y).toBe(50)
  })

  it('preserves z-order of children', () => {
    const doc = baseDoc([makeRect('r1', 0, 0), makeRect('r2', 50, 0), makeRect('r3', 100, 0)])
    const grouped = applySceneOperation(doc, {
      type: 'group_elements', pageId: PAGE_ID, elementIds: ['r3', 'r1'], groupId: 'g1',
    })
    const group = grouped.pages[0]!.elements[0] as GroupElement
    // r1 was at index 0, r3 at index 2 → children preserve ascending index order
    expect(group.children[0]!.id).toBe('r1')
    expect(group.children[1]!.id).toBe('r3')
  })

  it('group inserted at bottommost former member index', () => {
    const doc = baseDoc([makeRect('r1', 0, 0), makeRect('r2', 50, 0), makeRect('r3', 100, 0)])
    const grouped = applySceneOperation(doc, {
      type: 'group_elements', pageId: PAGE_ID, elementIds: ['r2', 'r3'], groupId: 'g1',
    })
    const ids = grouped.pages[0]!.elements.map((e) => e.id)
    // r2 was at index 1, r3 at index 2; group takes slot 1; r1 stays at 0
    expect(ids[0]).toBe('r1')
    expect(ids[1]).toBe('g1')
    expect(ids).toHaveLength(2)
  })

  it('round-trip group→ungroup restores exact absolute positions', () => {
    const r1 = makeRect('r1', 30, 40, 100, 50)
    const r2 = makeRect('r2', 200, 150, 80, 60)
    const doc = baseDoc([r1, r2])

    const grouped = applySceneOperation(doc, {
      type: 'group_elements', pageId: PAGE_ID, elementIds: ['r1', 'r2'], groupId: 'g1',
    })
    const ungrouped = applySceneOperation(grouped, {
      type: 'ungroup_element', pageId: PAGE_ID, groupId: 'g1',
    })

    const els = ungrouped.pages[0]!.elements
    const restored1 = els.find((e) => e.id === 'r1')!
    const restored2 = els.find((e) => e.id === 'r2')!
    expect(restored1.x).toBe(30)
    expect(restored1.y).toBe(40)
    expect(restored2.x).toBe(200)
    expect(restored2.y).toBe(150)
  })

  /**
   * Rotation semantics: group/ungroup use additive x/y translation only —
   * child.rotation is unchanged. Absolute position is preserved for the child's
   * top-left origin (not its visual center). A child at page position (px, py)
   * with any rotation has the invariant: child.x === px, child.y === py before
   * and after grouping. The group's own origin is the min-AABB corner of all
   * member AABBs, but children store their top-left origin, not the AABB corner,
   * so rotated children stay at their original x/y in page coordinates.
   */
  it('rotated child keeps its top-left origin after group/ungroup round-trip', () => {
    // r1 is rotated 45°; its x/y top-left origin is what the model stores.
    const r1 = makeRect('r1', 50, 50)
    const rotated: RectElement = { ...r1, rotation: 45 }
    const r2 = makeRect('r2', 200, 200)
    const doc = baseDoc([rotated, r2])

    // The AABB of the rotated element extends beyond (50,50) in all directions,
    // so the group origin will be less than (50, 50).
    const grouped = applySceneOperation(doc, {
      type: 'group_elements', pageId: PAGE_ID, elementIds: ['r1', 'r2'], groupId: 'g1',
    })
    const group = grouped.pages[0]!.elements[0] as GroupElement
    const groupedChild = group.children.find((c) => c.id === 'r1')!

    // Child local x/y = original page x/y - group.x/y
    expect(groupedChild.x).toBeCloseTo(rotated.x - group.x, 6)
    expect(groupedChild.y).toBeCloseTo(rotated.y - group.y, 6)
    // Rotation is preserved unchanged on the child
    expect(groupedChild.rotation).toBe(45)

    const ungrouped = applySceneOperation(grouped, {
      type: 'ungroup_element', pageId: PAGE_ID, groupId: 'g1',
    })
    const restored = ungrouped.pages[0]!.elements.find((e) => e.id === 'r1')!
    // After ungroup: page x/y = child.x + group.x = original page x/y
    expect(restored.x).toBe(rotated.x)
    expect(restored.y).toBe(rotated.y)
    expect(restored.rotation).toBe(45)
  })

  it('ungroup re-absolutizes all children into owner at group index', () => {
    const inner1 = makeRect('r1', 0, 0)
    const inner2 = makeRect('r2', 50, 0)
    const group: GroupElement = { ...makeGroup('g1', [inner1, inner2]), x: 100, y: 200 }
    const doc = baseDoc([makeRect('r0', 0, 0), group])

    const result = applySceneOperation(doc, { type: 'ungroup_element', pageId: PAGE_ID, groupId: 'g1' })
    const els = result.pages[0]!.elements
    // r0 stays at index 0; children inserted at group's old index (1)
    expect(els[0]!.id).toBe('r0')
    const el1 = els.find((e) => e.id === 'r1')!
    const el2 = els.find((e) => e.id === 'r2')!
    expect(el1.x).toBe(100) // 0 + 100
    expect(el1.y).toBe(200) // 0 + 200
    expect(el2.x).toBe(150) // 50 + 100
    expect(el2.y).toBe(200) // 0 + 200
  })
})

// ---------------------------------------------------------------------------
// Page operations
// ---------------------------------------------------------------------------

describe('applySceneOperation — add_page', () => {
  it('appends page when no index given', () => {
    const result = applySceneOperation(baseDoc(), { type: 'add_page', pageId: 'p2', options: { name: 'Slide 2' } })
    expect(result.pages).toHaveLength(2)
    expect(result.pages[1]!.id).toBe('p2')
    expect(result.pages[1]!.name).toBe('Slide 2')
  })

  it('inserts page at explicit index', () => {
    const withTwo = applySceneOperation(baseDoc(), { type: 'add_page', pageId: 'p2' })
    const result = applySceneOperation(withTwo, { type: 'add_page', pageId: 'p3', index: 1 })
    expect(result.pages[1]!.id).toBe('p3')
    expect(result.pages[2]!.id).toBe('p2')
  })
})

describe('applySceneOperation — duplicate_page', () => {
  it('appends a copy of the source page with a new id', () => {
    resetMintCounter()
    const doc = baseDoc([makeRect('r1', 10, 20)])
    const result = applySceneOperations(doc, [{
      type: 'duplicate_page', sourcePageId: PAGE_ID, pageId: 'p2',
    }], DEFAULT_OPTS).document

    expect(result.pages).toHaveLength(2)
    expect(result.pages[1]!.id).toBe('p2')
  })

  it('re-mints all element ids so source and copy share no ids', () => {
    resetMintCounter()
    const doc = baseDoc([makeRect('r1'), makeRect('r2')])
    const result = applySceneOperations(doc, [{
      type: 'duplicate_page', sourcePageId: PAGE_ID, pageId: 'p2',
    }], DEFAULT_OPTS).document

    const sourceIds = new Set(result.pages[0]!.elements.map((e) => e.id))
    const copyIds = result.pages[1]!.elements.map((e) => e.id)
    for (const id of copyIds) {
      expect(sourceIds.has(id)).toBe(false)
    }
    // Copy has same element count
    expect(copyIds).toHaveLength(result.pages[0]!.elements.length)
  })

  it('re-minted ids are unique when the source has nested groups', () => {
    resetMintCounter()
    const inner = makeRect('inner', 0, 0)
    const group = makeGroup('grp', [inner])
    const doc = baseDoc([group, makeRect('outer')])

    const result = applySceneOperations(doc, [{
      type: 'duplicate_page', sourcePageId: PAGE_ID, pageId: 'p2',
    }], DEFAULT_OPTS).document

    const allIds = new Set<string>()
    function collectIds(elements: SceneElement[]): void {
      for (const el of elements) {
        expect(allIds.has(el.id)).toBe(false)
        allIds.add(el.id)
        if (el.kind === 'group') collectIds(el.children)
      }
    }
    for (const page of result.pages) {
      collectIds(page.elements)
    }
  })
})

describe('applySceneOperation — delete_page', () => {
  it('removes the page', () => {
    const doc = applySceneOperation(baseDoc(), { type: 'add_page', pageId: 'p2' })
    const result = applySceneOperation(doc, { type: 'delete_page', pageId: 'p2' })
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0]!.id).toBe(PAGE_ID)
  })

  it('throws when trying to delete the only remaining page', () => {
    expect(() => applySceneOperation(baseDoc(), { type: 'delete_page', pageId: PAGE_ID }))
      .toThrow(/last page/)
  })
})

describe('applySceneOperation — reorder_page', () => {
  it('moves page to target index', () => {
    const doc = applySceneOperation(baseDoc(), { type: 'add_page', pageId: 'p2' })
    const result = applySceneOperation(doc, { type: 'reorder_page', pageId: 'p2', toIndex: 0 })
    expect(result.pages[0]!.id).toBe('p2')
    expect(result.pages[1]!.id).toBe(PAGE_ID)
  })
})

describe('applySceneOperation — set_page_props', () => {
  it('updates name, width, height, background, bleed', () => {
    const result = applySceneOperation(baseDoc(), {
      type: 'set_page_props', pageId: PAGE_ID,
      name: 'Cover', width: 720, height: 1280, background: '#000000',
      bleed: { top: 3, right: 3, bottom: 3, left: 3 },
    })
    const page = result.pages[0]!
    expect(page.name).toBe('Cover')
    expect(page.width).toBe(720)
    expect(page.height).toBe(1280)
    expect(page.background).toBe('#000000')
    expect(page.bleed).toEqual({ top: 3, right: 3, bottom: 3, left: 3 })
  })

  it('null bleed clears it', () => {
    const withBleed = applySceneOperation(baseDoc(), {
      type: 'set_page_props', pageId: PAGE_ID,
      bleed: { top: 3, right: 3, bottom: 3, left: 3 },
    })
    const result = applySceneOperation(withBleed, {
      type: 'set_page_props', pageId: PAGE_ID, bleed: null,
    })
    expect(result.pages[0]!.bleed).toBeNull()
  })
})

describe('applySceneOperation — set_page_guides', () => {
  it('replaces guide arrays', () => {
    const result = applySceneOperation(baseDoc(), {
      type: 'set_page_guides', pageId: PAGE_ID,
      guides: { vertical: [100, 300], horizontal: [200] },
    })
    expect(result.pages[0]!.guides).toEqual({ vertical: [100, 300], horizontal: [200] })
  })
})

describe('applySceneOperation — bind_slot', () => {
  it('assigns slot name to element', () => {
    const doc = baseDoc([makeRect('r1')])
    const result = applySceneOperation(doc, {
      type: 'bind_slot', pageId: PAGE_ID, elementId: 'r1', slot: 'primary_bg',
    })
    expect((result.pages[0]!.elements[0] as RectElement).slot).toBe('primary_bg')
  })

  it('null slot removes the slot property', () => {
    const el = { ...makeRect('r1'), slot: 'old_slot' }
    const doc = baseDoc([el])
    const result = applySceneOperation(doc, {
      type: 'bind_slot', pageId: PAGE_ID, elementId: 'r1', slot: null,
    })
    expect('slot' in result.pages[0]!.elements[0]!).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// apply_data — slot typing
// ---------------------------------------------------------------------------

describe('applySceneOperation — apply_data', () => {
  it('text slot: updates text content', () => {
    const el = { ...makeText('t1'), slot: 'headline' }
    const doc = baseDoc([el])
    const result = applySceneOperation(doc, {
      type: 'apply_data', bindings: { headline: 'New Headline' },
    })
    const t = result.pages[0]!.elements[0] as TextElement
    expect(t.text).toBe('New Headline')
  })

  it('image slot: replaces src', () => {
    const el = { ...makeImage('img1'), slot: 'hero' }
    const doc = baseDoc([el])
    const result = applySceneOperation(doc, {
      type: 'apply_data', bindings: { hero: 'https://cdn.example/new.png' },
    })
    const img = result.pages[0]!.elements[0] as ImageElement
    expect(img.src).toBe('https://cdn.example/new.png')
  })

  it('video slot: replaces src', () => {
    const el = { ...makeVideo('v1'), slot: 'clip' }
    const doc = baseDoc([el])
    const result = applySceneOperation(doc, {
      type: 'apply_data', bindings: { clip: 'https://cdn.example/new.mp4' },
    })
    const vid = result.pages[0]!.elements[0] as VideoElement
    expect(vid.src).toBe('https://cdn.example/new.mp4')
  })

  it('rect slot: recolors fill', () => {
    const el = { ...makeRect('r1'), slot: 'bg' }
    const doc = baseDoc([el])
    const result = applySceneOperation(doc, {
      type: 'apply_data', bindings: { bg: '#0000ff' },
    })
    const r = result.pages[0]!.elements[0] as RectElement
    expect(r.fill).toBe('#0000ff')
  })

  it('ellipse slot: recolors fill', () => {
    const el = { ...makeEllipse('e1'), slot: 'dot' }
    const doc = baseDoc([el])
    const result = applySceneOperation(doc, {
      type: 'apply_data', bindings: { dot: '#ff00ff' },
    })
    const e = result.pages[0]!.elements[0] as EllipseElement
    expect(e.fill).toBe('#ff00ff')
  })

  it('line slot: recolors stroke', () => {
    const el = { ...makeLine('l1'), slot: 'border' }
    const doc = baseDoc([el])
    const result = applySceneOperation(doc, {
      type: 'apply_data', bindings: { border: '#ff0000' },
    })
    const l = result.pages[0]!.elements[0] as LineElement
    expect(l.stroke).toBe('#ff0000')
  })

  it('group slot: propagates color to children recursively', () => {
    const inner = makeRect('r1', 0, 0)
    const innerLine = makeLine('l1')
    const innerGroup = makeGroup('g_inner', [innerLine])
    const group: GroupElement = {
      ...makeGroup('g1', [inner, innerGroup]),
      slot: 'theme_color',
    }
    const doc = baseDoc([group])
    const result = applySceneOperation(doc, {
      type: 'apply_data', bindings: { theme_color: '#aabbcc' },
    })
    const outerGroup = result.pages[0]!.elements[0] as GroupElement
    const child1 = outerGroup.children.find((c) => c.id === 'r1') as RectElement
    const childGroup = outerGroup.children.find((c) => c.id === 'g_inner') as GroupElement
    const childLine = childGroup.children.find((c) => c.id === 'l1') as LineElement
    expect(child1.fill).toBe('#aabbcc')
    expect(childLine.stroke).toBe('#aabbcc')
  })

  it('throws on unknown slot name', () => {
    expect(() => applySceneOperation(baseDoc(), {
      type: 'apply_data', bindings: { missing_slot: 'value' },
    })).toThrow(/slot "missing_slot"/)
  })

  it('partial apply: only specified slots are changed', () => {
    const el1 = { ...makeText('t1'), slot: 's1', text: 'original1' }
    const el2 = { ...makeText('t2'), slot: 's2', text: 'original2' }
    const doc = baseDoc([el1, el2])
    const result = applySceneOperation(doc, {
      type: 'apply_data', bindings: { s1: 'updated' },
    })
    const els = result.pages[0]!.elements
    expect((els.find((e) => e.id === 't1') as TextElement).text).toBe('updated')
    expect((els.find((e) => e.id === 't2') as TextElement).text).toBe('original2')
  })
})

describe('applySceneOperation — set_document_title', () => {
  it('updates the title', () => {
    const result = applySceneOperation(baseDoc(), { type: 'set_document_title', title: 'Q4 Campaign' })
    expect(result.title).toBe('Q4 Campaign')
  })
})

// ---------------------------------------------------------------------------
// applySceneOperations — result objects
// ---------------------------------------------------------------------------

describe('applySceneOperations — result objects', () => {
  it('add_element result has kind:element with pageId and element', () => {
    resetMintCounter()
    const { results } = applySceneOperations(baseDoc(), [
      { type: 'add_element', pageId: PAGE_ID, element: makeRect('r1') },
    ], DEFAULT_OPTS)
    expect(results[0]).toMatchObject({ kind: 'element', pageId: PAGE_ID })
    expect((results[0] as { kind: 'element'; element: SceneElement }).element.id).toBe('r1')
  })

  it('add_page result has kind:page', () => {
    resetMintCounter()
    const { results } = applySceneOperations(baseDoc(), [
      { type: 'add_page', pageId: 'p2' },
    ], DEFAULT_OPTS)
    expect(results[0]).toMatchObject({ kind: 'page' })
  })

  it('set_document_title result has kind:document', () => {
    resetMintCounter()
    const { results } = applySceneOperations(baseDoc(), [
      { type: 'set_document_title', title: 'X' },
    ], DEFAULT_OPTS)
    expect(results[0]).toMatchObject({ kind: 'document' })
  })
})

// ---------------------------------------------------------------------------
// storeApplyScenePlan — store integration
// ---------------------------------------------------------------------------

function makeFakeStore(doc: SceneDocument, initialRev = 1): SceneStore {
  let currentDoc = doc
  let currentRev = initialRev
  return {
    async getDocument() {
      return { document: currentDoc, rev: currentRev }
    },
    async saveDocument(newDoc, expectedRev) {
      if (expectedRev !== currentRev) throw new Error(`stale rev: expected ${currentRev}, got ${expectedRev}`)
      currentDoc = newDoc
      currentRev += 1
      return { document: currentDoc, rev: currentRev }
    },
    async recordDecision(input) {
      return {
        id: 'dec-1',
        kind: input.kind,
        instruction: input.instruction,
        reasoningSummary: input.reasoningSummary ?? null,
        metadata: input.metadata ?? {},
        createdAt: new Date(),
      }
    },
    async createExport(format) {
      return { id: 'exp-1', format, status: 'queued', resultUrl: null, metadata: {}, createdAt: new Date() }
    },
    async listDecisions() { return [] },
    async listExports() { return [] },
  }
}

describe('storeApplyScenePlan', () => {
  it('happy path: validates, applies, saves, records decision', async () => {
    resetMintCounter()
    const doc = baseDoc([makeRect('r1', 0, 0)])
    const store = makeFakeStore(doc, 5)
    const plan = {
      summary: 'move r1',
      operations: [{ type: 'set_attrs' as const, pageId: PAGE_ID, elementId: 'r1', attrs: { x: 99 } }],
    }
    const { record, results } = await storeApplyScenePlan(store, plan, {
      actorKind: 'agent_edit',
      mintId,
    })
    expect(record.rev).toBe(6)
    expect(results).toHaveLength(1)
    const el = (await store.getDocument()).document.pages[0]!.elements[0] as RectElement
    expect(el.x).toBe(99)
  })

  it('retries once on stale rev and succeeds', async () => {
    resetMintCounter()
    const doc = baseDoc([makeRect('r1', 0, 0)])
    let callCount = 0
    let currentDoc = doc
    let currentRev = 3

    // Store that rejects the first save (simulating a concurrent edit) then accepts
    const store: SceneStore = {
      async getDocument() {
        return { document: currentDoc, rev: currentRev }
      },
      async saveDocument(newDoc, expectedRev) {
        callCount += 1
        if (callCount === 1) {
          // Simulate concurrent edit: advance rev before first save attempt
          currentRev = 4
          throw new Error('stale rev: expected 4, got 3')
        }
        if (expectedRev !== currentRev) {
          throw new Error(`stale rev: expected ${currentRev}, got ${expectedRev}`)
        }
        currentDoc = newDoc
        currentRev += 1
        return { document: currentDoc, rev: currentRev }
      },
      async recordDecision(input) {
        return { id: 'd1', kind: input.kind, instruction: input.instruction, reasoningSummary: null, metadata: {}, createdAt: new Date() }
      },
      async createExport(format) {
        return { id: 'e1', format, status: 'queued', resultUrl: null, metadata: {}, createdAt: new Date() }
      },
      async listDecisions() { return [] },
      async listExports() { return [] },
    }

    const plan = {
      summary: 'update x',
      operations: [{ type: 'set_attrs' as const, pageId: PAGE_ID, elementId: 'r1', attrs: { x: 50 } }],
    }
    const { record } = await storeApplyScenePlan(store, plan, { actorKind: 'agent_edit', mintId })
    // After retry: rev was 4, save increments to 5
    expect(record.rev).toBe(5)
    expect(callCount).toBe(2)
  })

  it('throws with descriptive message when still stale after retry', async () => {
    resetMintCounter()
    const doc = baseDoc([makeRect('r1', 0, 0)])
    const store: SceneStore = {
      async getDocument() { return { document: doc, rev: 1 } },
      async saveDocument() { throw new Error('stale rev always') },
      async recordDecision(input) {
        return { id: 'd1', kind: input.kind, instruction: input.instruction, reasoningSummary: null, metadata: {}, createdAt: new Date() }
      },
      async createExport(format) {
        return { id: 'e1', format, status: 'queued', resultUrl: null, metadata: {}, createdAt: new Date() }
      },
      async listDecisions() { return [] },
      async listExports() { return [] },
    }
    const plan = {
      summary: 'test',
      operations: [{ type: 'set_attrs' as const, pageId: PAGE_ID, elementId: 'r1', attrs: { x: 1 } }],
    }
    await expect(storeApplyScenePlan(store, plan, { actorKind: 'agent_edit', mintId }))
      .rejects.toThrow(/stale rev persists after retry/)
  })

  it('records op-type counts in decision metadata', async () => {
    resetMintCounter()
    const doc = baseDoc([makeRect('r1'), makeRect('r2')])
    const decisions: Array<{ metadata: Record<string, unknown> }> = []
    const store: SceneStore = {
      async getDocument() { return { document: doc, rev: 1 } },
      async saveDocument(newDoc) { return { document: newDoc, rev: 2 } },
      async recordDecision(input) {
        const d = { id: 'd1', kind: input.kind, instruction: input.instruction, reasoningSummary: null, metadata: input.metadata ?? {}, createdAt: new Date() }
        decisions.push(d)
        return d
      },
      async createExport(format) {
        return { id: 'e1', format, status: 'queued', resultUrl: null, metadata: {}, createdAt: new Date() }
      },
      async listDecisions() { return [] },
      async listExports() { return [] },
    }
    const plan = {
      summary: 'batch',
      operations: [
        { type: 'set_attrs' as const, pageId: PAGE_ID, elementId: 'r1', attrs: { x: 1 } },
        { type: 'set_attrs' as const, pageId: PAGE_ID, elementId: 'r2', attrs: { x: 2 } },
        { type: 'set_document_title' as const, title: 'Updated' },
      ],
    }
    await storeApplyScenePlan(store, plan, { actorKind: 'human_edit', mintId })
    expect(decisions).toHaveLength(1)
    const meta = decisions[0]!.metadata as { opTypeCounts: Record<string, number>; operationCount: number }
    expect(meta.opTypeCounts['set_attrs']).toBe(2)
    expect(meta.opTypeCounts['set_document_title']).toBe(1)
    expect(meta.operationCount).toBe(3)
  })
})
