/**
 * Property/fuzz harness for the design-canvas apply+validate pipeline.
 * fast-check drives random operation batches through the validate-then-apply
 * path and asserts two structural invariants the surface promises:
 *
 *   1. Id-uniqueness — no two elements (or element-vs-page) share an id across
 *      the whole document, no matter what add/group/duplicate sequence ran.
 *   2. Group ↔ ungroup round-trip — grouping a set of siblings then ungrouping
 *      the result restores every child to its original absolute position
 *      (x, y, rotation), the contract that makes grouping non-destructive.
 *
 * A validated op that lands MUST keep the invariants; an invalid op throws
 * loud. A document that violates an invariant without a throw is a real bug.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { applySceneOperations } from '../../src/design-canvas/apply'
import {
  createEmptyDocument,
  type RectElement,
  type SceneDocument,
  type SceneElement,
} from '../../src/design-canvas/model'
import type { SceneOperation } from '../../src/design-canvas/operations'
import { validateSceneOperations } from '../../src/design-canvas/validate'

const PAGE_ID = 'page-1'

function rect(id: string, x: number, y: number, rotation = 0): RectElement {
  return {
    id,
    kind: 'rect',
    name: id,
    x,
    y,
    rotation,
    opacity: 1,
    locked: false,
    visible: true,
    width: 40,
    height: 30,
    fill: '#ff0000',
  }
}

function allElementIds(document: SceneDocument): string[] {
  const ids: string[] = []
  for (const page of document.pages) {
    const stack: SceneElement[] = [...page.elements]
    while (stack.length > 0) {
      const el = stack.pop()!
      ids.push(el.id)
      if (el.kind === 'group') stack.push(...el.children)
    }
  }
  return ids
}

function assertIdsUnique(document: SceneDocument): void {
  const ids = allElementIds(document)
  const pageIds = document.pages.map((p) => p.id)
  const all = [...ids, ...pageIds]
  expect(new Set(all).size, `unique ids (saw ${all.length}, distinct ${new Set(all).size})`).toBe(all.length)
}

describe('design-canvas apply — property: id-uniqueness', () => {
  it('random add/duplicate batches never collide ids', () => {
    const idArb = fc.integer({ min: 0, max: 30 }).map((n) => `e${n}`)
    const opArb: fc.Arbitrary<SceneOperation> = fc.oneof(
      fc.record({ id: idArb, x: fc.integer({ min: 0, max: 500 }), y: fc.integer({ min: 0, max: 500 }) }).map(
        ({ id, x, y }): SceneOperation => ({ type: 'add_element', pageId: PAGE_ID, element: rect(id, x, y) }),
      ),
      fc.record({ pageId: fc.constantFrom('dup1', 'dup2', 'dup3') }).map(
        ({ pageId }): SceneOperation => ({ type: 'duplicate_page', sourcePageId: PAGE_ID, pageId }),
      ),
    )
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 14 }), (operations) => {
        let doc = createEmptyDocument('fuzz')
        let counter = 0
        const mintId = () => `minted-${(counter += 1)}`
        for (const op of operations) {
          try {
            validateSceneOperations(doc, [op])
          } catch {
            continue
          }
          doc = applySceneOperations(doc, [op], { mintId }).document
          assertIdsUnique(doc)
        }
      }),
      { numRuns: 300 },
    )
  })
})

describe('design-canvas apply — property: group/ungroup round-trip', () => {
  it('grouping then ungrouping siblings restores every absolute position', () => {
    const elementArb = fc.record({
      x: fc.integer({ min: -100, max: 800 }),
      y: fc.integer({ min: -100, max: 800 }),
      rotation: fc.constantFrom(0, 45, 90, 180, 270),
    })
    fc.assert(
      fc.property(fc.array(elementArb, { minLength: 2, maxLength: 6 }), (specs) => {
        let doc = createEmptyDocument('round-trip')
        const ids = specs.map((_, i) => `r${i}`)
        for (let i = 0; i < specs.length; i += 1) {
          const s = specs[i]!
          doc = applySceneOperations(doc, [
            { type: 'add_element', pageId: PAGE_ID, element: rect(ids[i]!, s.x, s.y, s.rotation) },
          ])
        }
        const before = new Map(
          allElementsFlat(doc).map((el) => [el.id, { x: el.x, y: el.y, rotation: el.rotation }]),
        )

        const groupOp: SceneOperation = { type: 'group_elements', pageId: PAGE_ID, elementIds: ids, groupId: 'g' }
        validateSceneOperations(doc, [groupOp])
        doc = applySceneOperations(doc, [groupOp])

        const ungroupOp: SceneOperation = { type: 'ungroup_element', pageId: PAGE_ID, groupId: 'g' }
        validateSceneOperations(doc, [ungroupOp])
        doc = applySceneOperations(doc, [ungroupOp])

        for (const el of allElementsFlat(doc)) {
          const original = before.get(el.id)
          if (!original) continue
          expect(el.x, `${el.id} x restored`).toBeCloseTo(original.x, 6)
          expect(el.y, `${el.id} y restored`).toBeCloseTo(original.y, 6)
          expect(el.rotation, `${el.id} rotation restored`).toBe(original.rotation)
        }
      }),
      { numRuns: 300 },
    )
  })
})

function allElementsFlat(document: SceneDocument): SceneElement[] {
  const out: SceneElement[] = []
  for (const page of document.pages) {
    const stack: SceneElement[] = [...page.elements]
    while (stack.length > 0) {
      const el = stack.pop()!
      out.push(el)
      if (el.kind === 'group') stack.push(...el.children)
    }
  }
  return out
}
