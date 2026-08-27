import { describe, expect, it } from 'vitest'

import { applySceneOperation, applySceneOperations } from '../../src/design-canvas/apply'
import {
  boundsIntersect,
  createEmptyDocument,
  elementAabb,
  elementExtent,
  type Bounds,
  type GroupElement,
  type RectElement,
  type SceneDocument,
  type SceneElement,
  type ScenePage,
} from '../../src/design-canvas/model'
import type { SceneOperation } from '../../src/design-canvas/operations'
import type { EditorSceneState, SceneCommand } from '../../src/design-canvas-react/contracts'
import { SCENE_COMMAND_HISTORY_LIMIT, createSceneCommandStack } from '../../src/design-canvas-react/engine/command-stack'
import {
  addElementCommand,
  bindSlotCommand,
  deleteElementCommand,
  deletePageCommand,
  duplicatePageCommand,
  groupElementsCommand,
  multiSetAttrsCommand,
  reorderElementCommand,
  setAttrsCommand,
  setDocumentTitleCommand,
  setPageGuidesCommand,
  setPagePropsCommand,
  ungroupElementCommand,
  addPageCommand,
  reorderPageCommand,
} from '../../src/design-canvas-react/engine/commands'
import { createSnapEngine, collectGridTargets } from '../../src/design-canvas-react/engine/snap'
import { createZoomPanMath } from '../../src/design-canvas-react/engine/zoom-pan'
import { DUPLICATE_OFFSET, marqueeSelect, nudgeDelta } from '../../src/design-canvas-react/engine/selection'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeRect(id: string, x: number, y: number, w = 100, h = 50): RectElement {
  return {
    id,
    kind: 'rect',
    name: id,
    x,
    y,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    width: w,
    height: h,
    fill: '#ff0000',
  }
}

function makeDocument(elements: SceneElement[] = []): SceneDocument {
  const doc = createEmptyDocument('Test', { width: 1000, height: 800 })
  doc.pages[0]!.elements = elements
  return doc
}

function makeState(doc: SceneDocument, overrides: Partial<EditorSceneState> = {}): EditorSceneState {
  return {
    document: doc,
    activePageId: doc.pages[0]!.id,
    selectedElementIds: [],
    zoom: 1,
    panX: 0,
    panY: 0,
    gridEnabled: false,
    gridSize: 10,
    snapEnabled: true,
    showRulers: true,
    showBleed: false,
    ...overrides,
  }
}

const PAGE_ID = 'page-1'

/** execute → undo must restore the exact pre-state, AND inverseOperations must
 *  round-trip the document through applySceneOperations. */
function expectRoundTrip(command: SceneCommand, before: EditorSceneState): EditorSceneState {
  const after = command.execute(before)
  const restored = command.undo(after)
  expect(restored.document).toEqual(before.document)

  // Durable round-trip: applying inverseOperations to the post-execute document
  // must yield the pre-execute document.
  const inverted = applySceneOperations(after.document, command.inverseOperations())
  expect(inverted).toEqual(before.document)

  return after
}

// ---------------------------------------------------------------------------
// 1. addElementCommand
// ---------------------------------------------------------------------------

describe('addElementCommand', () => {
  it('inserts the element and inverts to delete_element', () => {
    const doc = makeDocument()
    const before = makeState(doc)
    const rect = makeRect('r1', 10, 20)
    const cmd = addElementCommand({ pageId: PAGE_ID, element: rect })

    const after = expectRoundTrip(cmd, before)
    expect(after.document.pages[0]!.elements).toHaveLength(1)
    expect(after.document.pages[0]!.elements[0]!.id).toBe('r1')
    expect(cmd.operations()).toEqual([{ type: 'add_element', pageId: PAGE_ID, element: rect }])
    expect(cmd.inverseOperations()).toEqual([{ type: 'delete_element', pageId: PAGE_ID, elementId: 'r1' }])
  })

  it('inserts at the specified index', () => {
    const doc = makeDocument([makeRect('r1', 0, 0), makeRect('r2', 100, 0)])
    const before = makeState(doc)
    const cmd = addElementCommand({ pageId: PAGE_ID, element: makeRect('r3', 50, 0), index: 1 })
    const after = cmd.execute(before)
    const ids = after.document.pages[0]!.elements.map((e) => e.id)
    expect(ids).toEqual(['r1', 'r3', 'r2'])
  })
})

// ---------------------------------------------------------------------------
// 2. setAttrsCommand (gesture command)
// ---------------------------------------------------------------------------

describe('setAttrsCommand', () => {
  it('round-trips and emits forward + inverse ops', () => {
    const doc = makeDocument([makeRect('r1', 10, 20)])
    const before = makeState(doc)
    const cmd = setAttrsCommand({
      pageId: PAGE_ID,
      elementId: 'r1',
      attrs: { x: 50, y: 80 },
      priorAttrs: { x: 10, y: 20 },
    })

    const after = expectRoundTrip(cmd, before)
    const el = after.document.pages[0]!.elements[0]! as RectElement
    expect(el.x).toBe(50)
    expect(el.y).toBe(80)
    expect(cmd.operations()).toEqual([{ type: 'set_attrs', pageId: PAGE_ID, elementId: 'r1', attrs: { x: 50, y: 80 } }])
    expect(cmd.inverseOperations()).toEqual([{ type: 'set_attrs', pageId: PAGE_ID, elementId: 'r1', attrs: { x: 10, y: 20 } }])
  })

  it('one undo step per drag — attrs is the full final state, not a delta', () => {
    const doc = makeDocument([makeRect('r1', 0, 0)])
    const before = makeState(doc)
    const cmd = setAttrsCommand({ pageId: PAGE_ID, elementId: 'r1', attrs: { x: 200 }, priorAttrs: { x: 0 } })
    const after = cmd.execute(before)
    const restored = cmd.undo(after)
    expect((restored.document.pages[0]!.elements[0]! as RectElement).x).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. multiSetAttrsCommand
// ---------------------------------------------------------------------------

describe('multiSetAttrsCommand', () => {
  it('applies N set_attrs as one undo step and round-trips', () => {
    const doc = makeDocument([makeRect('r1', 0, 0), makeRect('r2', 100, 0)])
    const before = makeState(doc)
    const cmd = multiSetAttrsCommand([
      { pageId: PAGE_ID, elementId: 'r1', attrs: { x: 50 }, priorAttrs: { x: 0 } },
      { pageId: PAGE_ID, elementId: 'r2', attrs: { x: 150 }, priorAttrs: { x: 100 } },
    ])

    const after = expectRoundTrip(cmd, before)
    expect((after.document.pages[0]!.elements[0]! as RectElement).x).toBe(50)
    expect((after.document.pages[0]!.elements[1]! as RectElement).x).toBe(150)
    expect(cmd.operations()).toHaveLength(2)
    expect(cmd.inverseOperations()).toHaveLength(2)
  })

  it('throws on empty entries', () => {
    expect(() => multiSetAttrsCommand([])).toThrow(/entries must not be empty/)
  })
})

// ---------------------------------------------------------------------------
// 4. reorderElementCommand
// ---------------------------------------------------------------------------

describe('reorderElementCommand', () => {
  it('round-trips reorder', () => {
    const doc = makeDocument([makeRect('r1', 0, 0), makeRect('r2', 100, 0), makeRect('r3', 200, 0)])
    const before = makeState(doc)
    const cmd = reorderElementCommand({ pageId: PAGE_ID, elementId: 'r1', toIndex: 2 })

    const after = expectRoundTrip(cmd, before)
    const ids = after.document.pages[0]!.elements.map((e) => e.id)
    expect(ids).toEqual(['r2', 'r3', 'r1'])
  })
})

// ---------------------------------------------------------------------------
// 5. deleteElementCommand
// ---------------------------------------------------------------------------

describe('deleteElementCommand', () => {
  it('removes the element and undo restores it at the exact index', () => {
    const doc = makeDocument([makeRect('r1', 0, 0), makeRect('r2', 100, 0)])
    const before = makeState(doc, { selectedElementIds: ['r1', 'r2'] })
    const cmd = deleteElementCommand({ document: doc, pageId: PAGE_ID, elementId: 'r1' })

    const after = cmd.execute(before)
    expect(after.document.pages[0]!.elements.map((e) => e.id)).toEqual(['r2'])
    expect(after.selectedElementIds).not.toContain('r1')

    const restored = cmd.undo(after)
    expect(restored.document.pages[0]!.elements.map((e) => e.id)).toEqual(['r1', 'r2'])

    // Durable ops round-trip
    const inverted = applySceneOperations(after.document, cmd.inverseOperations())
    expect(inverted.pages[0]!.elements.map((e) => e.id)).toEqual(['r1', 'r2'])
  })

  it('inverse op is add_element with the full snapshot', () => {
    const rect = makeRect('r1', 10, 20)
    const doc = makeDocument([rect])
    const cmd = deleteElementCommand({ document: doc, pageId: PAGE_ID, elementId: 'r1' })
    const [inv] = cmd.inverseOperations()
    expect(inv).toMatchObject({ type: 'add_element', pageId: PAGE_ID, element: rect, index: 0 })
  })
})

// ---------------------------------------------------------------------------
// 6. groupElementsCommand / ungroupElementCommand
// ---------------------------------------------------------------------------

describe('groupElementsCommand', () => {
  it('groups 2 elements and undo restores exact pre-state', () => {
    const r1 = makeRect('r1', 10, 20)
    const r2 = makeRect('r2', 200, 300)
    const doc = makeDocument([r1, r2])
    const before = makeState(doc)
    const cmd = groupElementsCommand({
      document: doc,
      pageId: PAGE_ID,
      elementIds: ['r1', 'r2'],
      groupId: 'g1',
      name: 'My Group',
    })

    const after = expectRoundTrip(cmd, before)
    const elements = after.document.pages[0]!.elements
    expect(elements).toHaveLength(1)
    const group = elements[0]!
    expect(group.kind).toBe('group')
    expect(group.id).toBe('g1')
    expect(after.selectedElementIds).toEqual(['g1'])

    if (group.kind !== 'group') throw new Error('expected group')
    // Group origin is at the minimum bounding box corner
    expect(group.x).toBe(10)
    expect(group.y).toBe(20)
    // Children are in group-local coords
    const child1 = group.children.find((c) => c.id === 'r1')
    const child2 = group.children.find((c) => c.id === 'r2')
    expect(child1).toBeDefined()
    expect(child2).toBeDefined()
    expect(child1!.x).toBe(0) // 10 - 10
    expect(child1!.y).toBe(0) // 20 - 20
    expect(child2!.x).toBe(190) // 200 - 10
    expect(child2!.y).toBe(280) // 300 - 20
  })

  it('throws with fewer than 2 element ids', () => {
    const doc = makeDocument([makeRect('r1', 0, 0)])
    expect(() => groupElementsCommand({ document: doc, pageId: PAGE_ID, elementIds: ['r1'], groupId: 'g1' })).toThrow(/≥ 2/)
  })

  it('operations round-trip through applySceneOperations', () => {
    const doc = makeDocument([makeRect('r1', 10, 10), makeRect('r2', 100, 100)])
    const before = makeState(doc)
    const cmd = groupElementsCommand({
      document: doc,
      pageId: PAGE_ID,
      elementIds: ['r1', 'r2'],
      groupId: 'g1',
    })
    const after = cmd.execute(before)
    const fromOps = applySceneOperations(doc, cmd.operations())
    expect(fromOps).toEqual(after.document)
  })
})

describe('ungroupElementCommand', () => {
  it('ungroups and undo restores the group (children rebased back)', () => {
    // Set up a pre-grouped document
    const doc = makeDocument([makeRect('r1', 10, 20), makeRect('r2', 200, 300)])
    const grouped = applySceneOperation(doc, {
      type: 'group_elements',
      pageId: PAGE_ID,
      elementIds: ['r1', 'r2'],
      groupId: 'g1',
    })
    const before = makeState(grouped)
    const cmd = ungroupElementCommand({ document: grouped, pageId: PAGE_ID, groupId: 'g1' })

    const after = expectRoundTrip(cmd, before)
    const elements = after.document.pages[0]!.elements
    expect(elements).toHaveLength(2)
    // Children back in page coords
    const r1 = elements.find((e) => e.id === 'r1')!
    const r2 = elements.find((e) => e.id === 'r2')!
    expect(r1.x).toBe(10)
    expect(r1.y).toBe(20)
    expect(r2.x).toBe(200)
    expect(r2.y).toBe(300)
  })

  it('throws when target is not a group', () => {
    const doc = makeDocument([makeRect('r1', 0, 0)])
    expect(() => ungroupElementCommand({ document: doc, pageId: PAGE_ID, groupId: 'r1' })).toThrow(/group/)
  })
})

// ---------------------------------------------------------------------------
// 7. Page commands
// ---------------------------------------------------------------------------

describe('addPageCommand', () => {
  it('adds a page and undo removes it', () => {
    const doc = makeDocument()
    const before = makeState(doc)
    const cmd = addPageCommand({ pageId: 'page-2', options: { name: 'Slide 2' } })

    const after = expectRoundTrip(cmd, before)
    expect(after.document.pages).toHaveLength(2)
    expect(after.activePageId).toBe('page-2')
  })
})

describe('duplicatePageCommand', () => {
  it('duplicates a page and undo removes the copy', () => {
    const doc = makeDocument([makeRect('r1', 0, 0)])
    const before = makeState(doc)
    const cmd = duplicatePageCommand({ document: doc, sourcePageId: PAGE_ID, pageId: 'page-copy' })

    const after = expectRoundTrip(cmd, before)
    expect(after.document.pages).toHaveLength(2)
    expect(after.activePageId).toBe('page-copy')
    // Copy has same elements (pre-server-id-remint)
    expect(after.document.pages[1]!.elements).toHaveLength(1)
  })
})

describe('deletePageCommand', () => {
  it('removes a page; undo restores a shell at the same index', () => {
    const doc = makeDocument()
    // Add a second page first
    const twoPage = applySceneOperation(doc, { type: 'add_page', pageId: 'page-2' })
    const before = makeState(twoPage, { activePageId: 'page-2' })
    const cmd = deletePageCommand({ document: twoPage, pageId: 'page-2' })

    const after = cmd.execute(before)
    expect(after.document.pages).toHaveLength(1)
    expect(after.activePageId).toBe(PAGE_ID)
  })

  it('throws when deleting the last page', () => {
    const doc = makeDocument()
    expect(() => deletePageCommand({ document: doc, pageId: PAGE_ID })).toThrow(/last page/)
  })
})

describe('reorderPageCommand', () => {
  it('moves a page and round-trips after execute', () => {
    const doc = makeDocument()
    const twoPage = applySceneOperation(applySceneOperation(doc, { type: 'add_page', pageId: 'page-2' }), { type: 'add_page', pageId: 'page-3' })
    const before = makeState(twoPage)
    const cmd = reorderPageCommand({ pageId: 'page-3', toIndex: 0 })

    const after = cmd.execute(before)
    expect(after.document.pages.map((p) => p.id)).toEqual(['page-3', PAGE_ID, 'page-2'])

    // Undo restores
    const restored = cmd.undo(after)
    expect(restored.document.pages.map((p) => p.id)).toEqual([PAGE_ID, 'page-2', 'page-3'])
  })
})

describe('setPagePropsCommand', () => {
  it('round-trips width/height/background changes', () => {
    const doc = makeDocument()
    const before = makeState(doc)
    const cmd = setPagePropsCommand({ document: doc, pageId: PAGE_ID, props: { width: 1920, height: 1080, background: '#000000' } })
    expectRoundTrip(cmd, before)
    const after = cmd.execute(before)
    expect(after.document.pages[0]!.width).toBe(1920)
    expect(after.document.pages[0]!.background).toBe('#000000')
  })
})

describe('setPageGuidesCommand', () => {
  it('round-trips guide changes', () => {
    const doc = makeDocument()
    const before = makeState(doc)
    const cmd = setPageGuidesCommand({
      document: doc,
      pageId: PAGE_ID,
      guides: { vertical: [100, 200], horizontal: [300] },
    })
    expectRoundTrip(cmd, before)
    const after = cmd.execute(before)
    expect(after.document.pages[0]!.guides.vertical).toEqual([100, 200])
  })
})

// ---------------------------------------------------------------------------
// 8. bindSlotCommand
// ---------------------------------------------------------------------------

describe('bindSlotCommand', () => {
  it('binds and unbinds a slot, round-tripping both ways', () => {
    const doc = makeDocument([makeRect('r1', 0, 0)])
    const before = makeState(doc)
    const bindCmd = bindSlotCommand({ document: doc, pageId: PAGE_ID, elementId: 'r1', slot: 'headline' })
    const afterBind = expectRoundTrip(bindCmd, before)
    expect(afterBind.document.pages[0]!.elements[0]!.slot).toBe('headline')

    const unbindCmd = bindSlotCommand({ document: afterBind.document, pageId: PAGE_ID, elementId: 'r1', slot: null })
    const afterUnbind = expectRoundTrip(unbindCmd, afterBind)
    expect(afterUnbind.document.pages[0]!.elements[0]!.slot).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 9. setDocumentTitleCommand
// ---------------------------------------------------------------------------

describe('setDocumentTitleCommand', () => {
  it('round-trips the title change', () => {
    const doc = makeDocument()
    const before = makeState(doc)
    const cmd = setDocumentTitleCommand({ document: doc, title: 'New Title' })
    const after = expectRoundTrip(cmd, before)
    expect(after.document.title).toBe('New Title')
    expect(cmd.operations()).toEqual([{ type: 'set_document_title', title: 'New Title' }])
    expect(cmd.inverseOperations()).toEqual([{ type: 'set_document_title', title: 'Test' }])
  })
})

// ---------------------------------------------------------------------------
// 10. createSceneCommandStack
// ---------------------------------------------------------------------------

describe('createSceneCommandStack', () => {
  it('executes, undoes, redoes with notifications', () => {
    const doc = makeDocument([makeRect('r1', 0, 0)])
    const stack = createSceneCommandStack(doc, PAGE_ID)
    const seen: number[] = []
    const unsub = stack.subscribe(() => {
      const el = stack.getState().document.pages[0]!.elements[0]! as RectElement
      seen.push(el.x)
    })

    const state = stack.getState()
    stack.execute(setAttrsCommand({ pageId: PAGE_ID, elementId: 'r1', attrs: { x: 50 }, priorAttrs: { x: 0 } }))
    expect((stack.getState().document.pages[0]!.elements[0]! as RectElement).x).toBe(50)
    expect(stack.canUndo()).toBe(true)
    expect(stack.canRedo()).toBe(false)

    stack.undo()
    expect((stack.getState().document.pages[0]!.elements[0]! as RectElement).x).toBe(0)
    expect(stack.canRedo()).toBe(true)

    stack.redo()
    expect((stack.getState().document.pages[0]!.elements[0]! as RectElement).x).toBe(50)
    expect(seen).toEqual([50, 0, 50])

    unsub()
    stack.undo()
    expect(seen).toEqual([50, 0, 50])
  })

  it('clears redo on execute', () => {
    const doc = makeDocument([makeRect('r1', 0, 0)])
    const stack = createSceneCommandStack(doc, PAGE_ID)
    stack.execute(setAttrsCommand({ pageId: PAGE_ID, elementId: 'r1', attrs: { x: 50 }, priorAttrs: { x: 0 } }))
    stack.undo()
    expect(stack.canRedo()).toBe(true)
    stack.execute(setAttrsCommand({ pageId: PAGE_ID, elementId: 'r1', attrs: { x: 30 }, priorAttrs: { x: 0 } }))
    expect(stack.canRedo()).toBe(false)
  })

  it('bounds history at SCENE_COMMAND_HISTORY_LIMIT', () => {
    const doc = makeDocument([makeRect('r1', 0, 0)])
    const stack = createSceneCommandStack(doc, PAGE_ID)
    for (let i = 0; i < SCENE_COMMAND_HISTORY_LIMIT + 5; i += 1) {
      const x = i % 2 === 0 ? 1 : 0
      stack.execute(setAttrsCommand({ pageId: PAGE_ID, elementId: 'r1', attrs: { x }, priorAttrs: { x: x === 1 ? 0 : 1 } }))
    }
    let undos = 0
    while (stack.canUndo()) {
      stack.undo()
      undos += 1
    }
    expect(undos).toBe(SCENE_COMMAND_HISTORY_LIMIT)
    expect(() => stack.undo()).toThrow(/nothing to undo/)
  })

  it('throws on undo/redo with empty history', () => {
    const doc = makeDocument()
    const stack = createSceneCommandStack(doc, PAGE_ID)
    expect(() => stack.undo()).toThrow(/nothing to undo/)
    expect(() => stack.redo()).toThrow(/nothing to redo/)
  })

  it('setView does not touch history', () => {
    const doc = makeDocument([makeRect('r1', 0, 0)])
    const stack = createSceneCommandStack(doc, PAGE_ID)
    stack.setView({ zoom: 2, panX: 100 })
    expect(stack.getState().zoom).toBe(2)
    expect(stack.canUndo()).toBe(false)
  })

  it('reset rebases the document, keeps history, drops stale selection', () => {
    const doc = makeDocument([makeRect('r1', 0, 0), makeRect('r2', 100, 0)])
    const stack = createSceneCommandStack(doc, PAGE_ID)
    stack.setView({ selectedElementIds: ['r1', 'r2'] })
    stack.execute(setAttrsCommand({ pageId: PAGE_ID, elementId: 'r1', attrs: { x: 50 }, priorAttrs: { x: 0 } }))

    // Server sends a fresh doc with r2 removed
    const refreshed = makeDocument([makeRect('r1', 50, 0)])
    stack.reset(refreshed)

    expect(stack.canUndo()).toBe(true)
    expect(stack.getState().selectedElementIds).not.toContain('r2')
    expect(stack.getState().selectedElementIds).toContain('r1')

    // Undo still works on the rebased state
    stack.undo()
    expect((stack.getState().document.pages[0]!.elements[0]! as RectElement).x).toBe(0)
  })

  it('reset falls back active page when it was deleted', () => {
    const doc = makeDocument()
    const twoPage = applySceneOperation(doc, { type: 'add_page', pageId: 'page-2' })
    const stack = createSceneCommandStack(twoPage, 'page-2')
    const onePageDoc = makeDocument()
    stack.reset(onePageDoc)
    expect(stack.getState().activePageId).toBe(PAGE_ID)
  })

  it('a throwing undo leaves history and state intact', () => {
    const doc = makeDocument([makeRect('r1', 0, 0)])
    const stack = createSceneCommandStack(doc, PAGE_ID)
    stack.execute(setAttrsCommand({ pageId: PAGE_ID, elementId: 'r1', attrs: { x: 50 }, priorAttrs: { x: 0 } }))

    // Rebase removes the element the command targets
    stack.reset(makeDocument([]))

    const stateBefore = stack.getState()
    expect(() => stack.undo()).toThrow()
    expect(stack.getState()).toBe(stateBefore)
    expect(stack.canUndo()).toBe(true)
    expect(stack.canRedo()).toBe(false)
  })

  it('a throwing redo leaves the redo stack intact', () => {
    const doc = makeDocument([makeRect('r1', 0, 0)])
    const stack = createSceneCommandStack(doc, PAGE_ID)
    stack.execute(setAttrsCommand({ pageId: PAGE_ID, elementId: 'r1', attrs: { x: 50 }, priorAttrs: { x: 0 } }))
    stack.undo()
    stack.reset(makeDocument([]))
    expect(() => stack.redo()).toThrow()
    expect(stack.canRedo()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 11. Snap engine
// ---------------------------------------------------------------------------

describe('createSnapEngine', () => {
  const snap = createSnapEngine()

  function baseState(elements: SceneElement[] = []): EditorSceneState {
    const doc = makeDocument(elements)
    doc.pages[0]!.guides = { vertical: [500], horizontal: [400] }
    return makeState(doc)
  }

  it('collects page edges, center, guide, and element edges', () => {
    const state = baseState([makeRect('r1', 100, 200)])
    const targets = snap.collectTargets(state, [])
    const vPositions = targets.vertical.map((t) => t.position)
    const hPositions = targets.horizontal.map((t) => t.position)

    // Page: x=0,500(center),1000
    expect(vPositions).toContain(0)
    expect(vPositions).toContain(500)
    expect(vPositions).toContain(1000)
    // Guide at 500 vertical
    const guideVert = targets.vertical.filter((t) => t.kind === 'guide')
    expect(guideVert.some((t) => t.position === 500)).toBe(true)
    // Element r1 edges
    expect(vPositions).toContain(100)   // left
    expect(vPositions).toContain(200)   // right (x + w)
    expect(hPositions).toContain(200)   // top
    expect(hPositions).toContain(250)   // bottom (y + h)
  })

  it('excludes elements by id', () => {
    const state = baseState([makeRect('r1', 100, 200)])
    const with_ = snap.collectTargets(state, [])
    const without = snap.collectTargets(state, ['r1'])
    const withElementEdges = with_.vertical.filter((t) => t.kind === 'element-edge').length
    expect(without.vertical.filter((t) => t.kind === 'element-edge').length).toBe(0)
    expect(withElementEdges).toBeGreaterThan(0)
  })

  it('snaps to nearest target within threshold', () => {
    const state = baseState()
    const targets = snap.collectTargets(state, [])
    // Page left edge is at x=0; bounds at x=3 with threshold 5px, zoom=1 → threshold=5doc
    const result = snap.apply({ x: 3, y: 400, width: 100, height: 50 }, targets, 5, 1)
    expect(result.x).toBe(0)
    expect(result.activeVertical).not.toBeNull()
    expect(result.activeVertical!.kind).not.toBe('grid')
  })

  it('threshold scales with zoom — screen px stays constant', () => {
    const state = baseState()
    const targets = snap.collectTargets(state, [])
    // 5 screen px threshold; at zoom=1 → 5 doc px; x=3 snaps (distance 3 < 5)
    const z1 = snap.apply({ x: 3, y: 0, width: 10, height: 10 }, targets, 5, 1)
    expect(z1.x).toBe(0) // snapped

    // At zoom=0.5 → threshold = 5/0.5 = 10 doc px; still snaps
    const z05 = snap.apply({ x: 3, y: 0, width: 10, height: 10 }, targets, 5, 0.5)
    expect(z05.x).toBe(0)

    // At zoom=10 → threshold = 5/10 = 0.5 doc px; x=3 (distance 3) doesn't snap
    const z10 = snap.apply({ x: 3, y: 0, width: 10, height: 10 }, targets, 5, 10)
    expect(z10.x).toBe(3) // not snapped
  })

  it('non-grid kinds beat grid on tie', () => {
    // Place a guide at the same position as a grid line
    const state = baseState()
    state.document.pages[0]!.guides = { vertical: [100], horizontal: [] }
    const targets = snap.collectTargets(state, [])

    // Add a grid target at the same position
    const gridTarget = { position: 100, kind: 'grid' as const }
    const mixedTargets = { vertical: [...targets.vertical, gridTarget], horizontal: targets.horizontal }

    const result = snap.apply({ x: 97, y: 0, width: 10, height: 10 }, mixedTargets, 10, 1)
    expect(result.activeVertical).not.toBeNull()
    expect(result.activeVertical!.kind).toBe('guide') // guide wins over grid at same distance
  })

  it('collectGridTargets generates lines in the neighborhood only', () => {
    const page = makeDocument().pages[0]!
    const bounds: Bounds = { x: 95, y: 95, width: 20, height: 20 }
    const { vertical, horizontal } = collectGridTargets(bounds, 10, page, 15)
    // Should include lines near 95..115 ± 15 = 80..130: 80,90,100,110,120,130
    expect(vertical.some((t) => t.position === 100)).toBe(true)
    expect(vertical.some((t) => t.position === 90)).toBe(true)
    // Should NOT include the entire page (line at 0 is outside 80)
    expect(vertical.some((t) => t.position === 0)).toBe(false)
  })

  it('throws on invalid zoom', () => {
    const state = baseState()
    const targets = snap.collectTargets(state, [])
    expect(() => snap.apply({ x: 0, y: 0, width: 10, height: 10 }, targets, 5, 0)).toThrow(/zoom/)
    expect(() => snap.apply({ x: 0, y: 0, width: 10, height: 10 }, targets, 5, -1)).toThrow(/zoom/)
  })
})

// ---------------------------------------------------------------------------
// 12. ZoomPanMath
// ---------------------------------------------------------------------------

describe('createZoomPanMath', () => {
  const zpm = createZoomPanMath({ minZoom: 0.05, maxZoom: 8 })

  it('zoomAtPoint fixed-point invariant: document point under cursor stays fixed', () => {
    const cases: Array<{ zoom: number; panX: number; panY: number; factor: number; screenX: number; screenY: number }> = [
      { zoom: 1, panX: 0, panY: 0, factor: 2, screenX: 400, screenY: 300 },
      { zoom: 2, panX: -100, panY: -50, factor: 0.5, screenX: 200, screenY: 200 },
      { zoom: 0.5, panX: 50, panY: 30, factor: 3, screenX: 150, screenY: 100 },
      { zoom: 4, panX: 200, panY: 150, factor: 0.25, screenX: 600, screenY: 400 },
    ]

    for (const { zoom, panX, panY, factor, screenX, screenY } of cases) {
      const state = { zoom, panX, panY }
      const docBefore = { x: (screenX - panX) / zoom, y: (screenY - panY) / zoom }
      const newState = zpm.zoomAtPoint(state, factor, screenX, screenY)
      const docAfter = { x: (screenX - newState.panX) / newState.zoom, y: (screenY - newState.panY) / newState.zoom }
      expect(docAfter.x).toBeCloseTo(docBefore.x, 10)
      expect(docAfter.y).toBeCloseTo(docBefore.y, 10)
    }
  })

  it('clamps zoom to min/max bounds', () => {
    const state = { zoom: 0.06, panX: 0, panY: 0 }
    const result = zpm.zoomAtPoint(state, 0.01, 100, 100)
    expect(result.zoom).toBeCloseTo(0.05, 10)

    const big = { zoom: 7, panX: 0, panY: 0 }
    const bigResult = zpm.zoomAtPoint(big, 10, 0, 0)
    expect(bigResult.zoom).toBe(8)
  })

  it('fitPage centers the page with default padding', () => {
    const result = zpm.fitPage({ width: 1000, height: 800 }, { width: 1100, height: 900 })
    // Available space: 1100 - 96 = 1004 wide, 900 - 96 = 804 tall
    // Fit zoom = min(1004/1000, 804/800) = min(1.004, 1.005) = 1.004
    expect(result.zoom).toBeCloseTo(1004 / 1000, 5)
    // Centered: panX = (1100 - 1000 * zoom) / 2
    expect(result.panX).toBeCloseTo((1100 - 1000 * result.zoom) / 2, 5)
  })

  it('fitPage respects custom padding', () => {
    const result = zpm.fitPage({ width: 1000, height: 500 }, { width: 1000, height: 500 }, 0)
    expect(result.zoom).toBe(1)
    expect(result.panX).toBe(0)
    expect(result.panY).toBe(0)
  })

  it('documentToScreen / screenToDocument are inverses', () => {
    const state = { zoom: 2, panX: 50, panY: -30 }
    const docPt = { x: 100, y: 200 }
    const screenPt = zpm.documentToScreen(state, docPt.x, docPt.y)
    const backToDoc = zpm.screenToDocument(state, screenPt.x, screenPt.y)
    expect(backToDoc.x).toBeCloseTo(docPt.x, 10)
    expect(backToDoc.y).toBeCloseTo(docPt.y, 10)
  })

  it('throws on invalid config', () => {
    expect(() => createZoomPanMath({ minZoom: 0, maxZoom: 8 })).toThrow(/minZoom/)
    expect(() => createZoomPanMath({ minZoom: 8, maxZoom: 8 })).toThrow(/maxZoom/)
    expect(() => createZoomPanMath({ minZoom: 8, maxZoom: 4 })).toThrow(/maxZoom/)
  })

  it('throws on invalid inputs', () => {
    expect(() => zpm.zoomAtPoint({ zoom: 0, panX: 0, panY: 0 }, 2, 0, 0)).toThrow(/zoom/)
    expect(() => zpm.zoomAtPoint({ zoom: 1, panX: 0, panY: 0 }, -1, 0, 0)).toThrow(/factor/)
    expect(() => zpm.fitPage({ width: 0, height: 100 }, { width: 100, height: 100 })).toThrow(/page.width/)
  })
})

// ---------------------------------------------------------------------------
// 13. marqueeSelect + nudgeDelta
// ---------------------------------------------------------------------------

describe('marqueeSelect', () => {
  it('selects intersecting elements by default (touch model)', () => {
    const page = makeDocument([
      makeRect('r1', 0, 0, 100, 100),
      makeRect('r2', 150, 0, 100, 100),
    ]).pages[0]!

    // Rect partially overlapping r1, not touching r2
    const result = marqueeSelect(page, { x: 50, y: 50, width: 60, height: 60 })
    expect(result).toContain('r1')
    expect(result).not.toContain('r2')
  })

  it('full containment mode only selects fully contained elements', () => {
    const page = makeDocument([
      makeRect('r1', 10, 10, 50, 50),   // fully inside [0,0,200,200]
      makeRect('r2', 150, 0, 100, 100), // right edge at 250, outside
    ]).pages[0]!

    const full = marqueeSelect(page, { x: 0, y: 0, width: 200, height: 200 }, { requireFullContainment: true })
    expect(full).toContain('r1')
    expect(full).not.toContain('r2')

    const touch = marqueeSelect(page, { x: 0, y: 0, width: 200, height: 200 })
    expect(touch).toContain('r1')
    expect(touch).toContain('r2')
  })

  it('excludes locked and invisible elements', () => {
    const locked = { ...makeRect('locked', 0, 0), locked: true }
    const hidden = { ...makeRect('hidden', 0, 0), visible: false }
    const page = makeDocument([locked, hidden]).pages[0]!
    const result = marqueeSelect(page, { x: -10, y: -10, width: 200, height: 200 })
    expect(result).toHaveLength(0)
  })

  it('descends into groups in intersection mode', () => {
    // Create a group with a child
    const doc = makeDocument([makeRect('r1', 10, 10), makeRect('r2', 200, 200)])
    const grouped = applySceneOperation(doc, {
      type: 'group_elements',
      pageId: PAGE_ID,
      elementIds: ['r1', 'r2'],
      groupId: 'g1',
    })
    const page = grouped.pages[0]!
    // Marquee that intersects the group but only covers r1 child area
    const result = marqueeSelect(page, { x: 5, y: 5, width: 110, height: 110 })
    // r1 (at group-local 0,0) falls in the marquee (page coords 10,10 + local 0,0 = 10,10)
    expect(result).toContain('r1')
  })
})

describe('nudgeDelta', () => {
  it('returns 1px deltas without shift', () => {
    expect(nudgeDelta('ArrowLeft', false)).toEqual({ dx: -1, dy: 0 })
    expect(nudgeDelta('ArrowRight', false)).toEqual({ dx: 1, dy: 0 })
    expect(nudgeDelta('ArrowUp', false)).toEqual({ dx: 0, dy: -1 })
    expect(nudgeDelta('ArrowDown', false)).toEqual({ dx: 0, dy: 1 })
  })

  it('returns 10px deltas with shift', () => {
    expect(nudgeDelta('ArrowLeft', true)).toEqual({ dx: -10, dy: 0 })
    expect(nudgeDelta('ArrowDown', true)).toEqual({ dx: 0, dy: 10 })
  })
})

describe('DUPLICATE_OFFSET', () => {
  it('is a non-zero offset', () => {
    expect(DUPLICATE_OFFSET.dx).toBeGreaterThan(0)
    expect(DUPLICATE_OFFSET.dy).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 14. apply.ts round-trip (applySceneOperations)
// ---------------------------------------------------------------------------

describe('applySceneOperations', () => {
  it('apply_data fills text and image slots', () => {
    const textEl: SceneElement = {
      id: 'txt1', kind: 'text', name: 'Title', x: 0, y: 0, rotation: 0, opacity: 1,
      locked: false, visible: true, slot: 'headline',
      text: 'placeholder', width: 300, fontFamily: 'Arial', fontSize: 24,
      fontStyle: 'normal', fill: '#000', align: 'left', lineHeight: 1.2, letterSpacing: 0,
    }
    const imgEl: SceneElement = {
      id: 'img1', kind: 'image', name: 'Photo', x: 0, y: 100, rotation: 0, opacity: 1,
      locked: false, visible: true, slot: 'cover',
      width: 400, height: 300, src: 'https://cdn.example/placeholder.png', fit: 'cover',
    }
    const doc = makeDocument([textEl, imgEl])
    const result = applySceneOperation(doc, {
      type: 'apply_data',
      bindings: { headline: 'Hello World', cover: 'https://cdn.example/real.jpg' },
    })
    const els = result.pages[0]!.elements
    const txt = els.find((e) => e.id === 'txt1')!
    const img = els.find((e) => e.id === 'img1')!
    if (txt.kind !== 'text') throw new Error('expected text')
    if (img.kind !== 'image') throw new Error('expected image')
    expect(txt.text).toBe('Hello World')
    expect(img.src).toBe('https://cdn.example/real.jpg')
  })

  it('apply_data throws on unknown slot', () => {
    const doc = makeDocument()
    expect(() => applySceneOperation(doc, { type: 'apply_data', bindings: { nope: 'val' } })).toThrow(/slot "nope" not found/)
  })

  it('delete_page throws on last page', () => {
    const doc = makeDocument()
    expect(() => applySceneOperation(doc, { type: 'delete_page', pageId: PAGE_ID })).toThrow(/last page/)
  })
})

// ---------------------------------------------------------------------------
// 15. Regression: reorderElementCommand undo after redo returns to origin
// ---------------------------------------------------------------------------

describe('reorderElementCommand — undo survives redo', () => {
  it('execute → undo → redo → undo brings element back to index 0 both times', () => {
    // 3 elements; move r1 (index 0) to index 2
    const doc = makeDocument([makeRect('r1', 0, 0), makeRect('r2', 100, 0), makeRect('r3', 200, 0)])
    const stack = createSceneCommandStack(doc, PAGE_ID)

    const cmd = reorderElementCommand({ pageId: PAGE_ID, elementId: 'r1', toIndex: 2 })
    stack.execute(cmd)
    const afterExecute = stack.getState().document.pages[0]!.elements.map((e) => e.id)
    expect(afterExecute).toEqual(['r2', 'r3', 'r1'])

    stack.undo()
    const afterUndo1 = stack.getState().document.pages[0]!.elements.map((e) => e.id)
    expect(afterUndo1).toEqual(['r1', 'r2', 'r3'])

    stack.redo()
    const afterRedo = stack.getState().document.pages[0]!.elements.map((e) => e.id)
    expect(afterRedo).toEqual(['r2', 'r3', 'r1'])

    // Second undo must also restore to index 0 (the original position),
    // not toIndex 2 (which is what execute() would capture on redo without the guard).
    stack.undo()
    const afterUndo2 = stack.getState().document.pages[0]!.elements.map((e) => e.id)
    expect(afterUndo2).toEqual(['r1', 'r2', 'r3'])
  })
})

describe('reorderPageCommand — undo survives redo', () => {
  it('execute → undo → redo → undo restores original page order both times', () => {
    const doc = applySceneOperation(
      applySceneOperation(makeDocument(), { type: 'add_page', pageId: 'page-2' }),
      { type: 'add_page', pageId: 'page-3' },
    )
    const stack = createSceneCommandStack(doc, PAGE_ID)

    // Move page-1 (index 0) to index 2
    const cmd = reorderPageCommand({ pageId: PAGE_ID, toIndex: 2 })
    stack.execute(cmd)
    expect(stack.getState().document.pages.map((p) => p.id)).toEqual(['page-2', 'page-3', PAGE_ID])

    stack.undo()
    expect(stack.getState().document.pages.map((p) => p.id)).toEqual([PAGE_ID, 'page-2', 'page-3'])

    stack.redo()
    expect(stack.getState().document.pages.map((p) => p.id)).toEqual(['page-2', 'page-3', PAGE_ID])

    stack.undo()
    // Must restore page-1 to index 0, not index 2
    expect(stack.getState().document.pages.map((p) => p.id)).toEqual([PAGE_ID, 'page-2', 'page-3'])
  })
})

// ---------------------------------------------------------------------------
// 16. Regression: deletePageCommand full-snapshot restore
// ---------------------------------------------------------------------------

describe('deletePageCommand — undo restores full page content', () => {
  it('undo restores elements and guides; inverseOperations() round-trips to server', () => {
    const doc = makeDocument([makeRect('r1', 10, 20), makeRect('r2', 100, 200)])
    const withGuides = applySceneOperation(doc, {
      type: 'set_page_guides', pageId: PAGE_ID,
      guides: { vertical: [100], horizontal: [200] },
    })
    const twoPage = applySceneOperation(withGuides, { type: 'add_page', pageId: 'page-2' })

    const before = makeState(twoPage)
    const cmd = deletePageCommand({ document: twoPage, pageId: PAGE_ID })

    const after = cmd.execute(before)
    expect(after.document.pages.map((p) => p.id)).toEqual(['page-2'])

    const restored = cmd.undo(after)
    const restoredPage = restored.document.pages.find((p) => p.id === PAGE_ID)!
    expect(restoredPage).toBeDefined()
    expect(restoredPage.elements.map((e) => e.id)).toEqual(['r1', 'r2'])
    expect(restoredPage.guides.vertical).toEqual([100])

    // Server-side round-trip: applying inverseOperations() must also restore elements
    const serverRestored = applySceneOperations(after.document, cmd.inverseOperations())
    const serverPage = serverRestored.pages.find((p) => p.id === PAGE_ID)!
    expect(serverPage.elements.map((e) => e.id)).toEqual(['r1', 'r2'])
    expect(serverPage.guides.vertical).toEqual([100])
  })
})

// ---------------------------------------------------------------------------
// 17. Regression: group elementExtent with rotated negative-AABB children
// ---------------------------------------------------------------------------

describe('elementExtent — group with rotated child whose AABB extends negative', () => {
  it('extent width matches elementAabb width for the same rotated child', () => {
    // A 100×100 rect at group-local (0,0) rotated 45°. Its AABB extends into
    // negative group-local x (the AABB left edge is at approximately -35).
    const rotatedChild: RectElement = {
      id: 'c1', kind: 'rect', name: 'c1',
      x: 0, y: 0, rotation: 45, opacity: 1, locked: false, visible: true,
      width: 100, height: 100, fill: '#ff0000',
    }
    const group: GroupElement = {
      id: 'g1', kind: 'group', name: 'g1',
      x: 50, y: 50, rotation: 0, opacity: 1, locked: false, visible: true,
      children: [rotatedChild],
    }

    const childAabb = elementAabb(rotatedChild)
    const { width, height } = elementExtent(group)

    // The group extent must cover the full AABB of the rotated child, including
    // any part that extends into negative group-local space.
    expect(width).toBeCloseTo(childAabb.width, 6)
    expect(height).toBeCloseTo(childAabb.height, 6)
  })
})

// ---------------------------------------------------------------------------
// 18. Regression: storeApplyScenePlan does NOT retry on non-stale-rev errors
// ---------------------------------------------------------------------------

describe('storeApplyScenePlan — non-stale-rev errors are not retried', () => {
  it('throws immediately without calling saveDocument a second time on constraint error', async () => {
    const { storeApplyScenePlan } = await import('../../src/design-canvas/apply')
    const doc = makeDocument([makeRect('r1', 0, 0)])
    let saveCount = 0
    // Minimal SceneStore stub — only saveDocument matters for this test
    const store = {
      async getDocument() { return { document: doc, rev: 1 } },
      async saveDocument(_d: SceneDocument, _r: number) {
        saveCount += 1
        throw new Error('SQLITE_CONSTRAINT_UNIQUE: design_documents.workspaceId')
      },
      async recordDecision(input: { kind: string; instruction: string }) {
        return { id: 'd1', kind: input.kind as 'agent_edit', instruction: input.instruction, reasoningSummary: null, metadata: {}, createdAt: new Date() }
      },
      async createExport(format: string) {
        return { id: 'e1', format: format as 'json', status: 'queued' as const, resultUrl: null, metadata: {}, createdAt: new Date() }
      },
      async listDecisions() { return [] as never[] },
      async listExports() { return [] as never[] },
    }
    const plan = {
      summary: 'test',
      operations: [{ type: 'set_attrs' as const, pageId: PAGE_ID, elementId: 'r1', attrs: { x: 1 } }],
    }
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      storeApplyScenePlan(store as any, plan, { actorKind: 'agent_edit', mintId: () => 'id-1' })
    ).rejects.toThrow(/SQLITE_CONSTRAINT_UNIQUE/)
    // Must not retry — saveDocument called exactly once (no second attempt on non-stale error)
    expect(saveCount).toBe(1)
  })
})
