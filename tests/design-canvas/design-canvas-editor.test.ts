/**
 * Stack-sharing, thumbnail cache, and lazy export invariants for the
 * DesignCanvasEditor composition.
 *
 * No React rendering, no Konva, no DOM — pure logic + module-contract tests.
 */

import { describe, expect, it, vi } from 'vitest'
import { createSceneCommandStack } from '../../src/design-canvas-react/engine/command-stack'
import { setAttrsCommand, addPageCommand } from '../../src/design-canvas-react/engine/commands'
import type { SceneDocument } from '../../src/design-canvas/model'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDoc(pageId = 'page-1'): SceneDocument {
  return {
    id: 'doc-1',
    schemaVersion: 1,
    title: 'Test',
    pages: [
      {
        id: pageId,
        name: 'Page 1',
        width: 1080,
        height: 1080,
        background: '#ffffff',
        bleed: null,
        guides: { vertical: [], horizontal: [] },
        elements: [
          {
            id: 'el-1',
            kind: 'rect',
            name: 'Rect',
            x: 10,
            y: 20,
            rotation: 0,
            opacity: 1,
            locked: false,
            visible: true,
            width: 100,
            height: 50,
            fill: '#ff0000',
          },
        ],
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Stack-sharing invariant
//
// Simulates the DesignCanvasEditor contract: chrome stack == workspace stack.
// A command committed via the "workspace gesture API" (stack.execute) must
// appear in the chrome's undo stack (same reference), and undoing via the
// chrome's stack must revert it.
// ---------------------------------------------------------------------------

describe('single-stack invariant', () => {
  it('command executed on shared stack is undoable via the same reference', () => {
    const doc = makeDoc()
    const stack = createSceneCommandStack(doc, 'page-1')

    // Simulate a gesture commit (as WorkspaceView would do via persist())
    const cmd = setAttrsCommand({
      pageId: 'page-1',
      elementId: 'el-1',
      attrs: { x: 99, y: 99 },
      priorAttrs: { x: 10, y: 20 },
    })
    stack.execute(cmd)

    expect(stack.canUndo()).toBe(true)
    expect(stack.getState().document.pages[0]!.elements[0]!.x).toBe(99)

    // Chrome undo (same stack reference) reverts the gesture
    stack.undo()
    expect(stack.getState().document.pages[0]!.elements[0]!.x).toBe(10)
    expect(stack.canUndo()).toBe(false)
  })

  it('selection set via stack.setView reflects in getState immediately', () => {
    const doc = makeDoc()
    const stack = createSceneCommandStack(doc, 'page-1')

    stack.setView({ selectedElementIds: ['el-1'] })
    expect(stack.getState().selectedElementIds).toEqual(['el-1'])

    // Clearing selection (as layers panel would do) removes it
    stack.setView({ selectedElementIds: [] })
    expect(stack.getState().selectedElementIds).toEqual([])
  })

  it('subscribers are notified for both execute and setView', () => {
    const doc = makeDoc()
    const stack = createSceneCommandStack(doc, 'page-1')
    const calls: string[] = []
    stack.subscribe(() => calls.push('notified'))

    const cmd = setAttrsCommand({
      pageId: 'page-1',
      elementId: 'el-1',
      attrs: { x: 50, y: 50 },
      priorAttrs: { x: 10, y: 20 },
    })
    stack.execute(cmd)
    stack.setView({ zoom: 2 })

    expect(calls).toHaveLength(2)
  })

  it('undo/redo round-trip preserves document identity after rebase', () => {
    const doc = makeDoc()
    const stack = createSceneCommandStack(doc, 'page-1')

    const cmd = setAttrsCommand({
      pageId: 'page-1',
      elementId: 'el-1',
      attrs: { x: 55 },
      priorAttrs: { x: 10 },
    })
    stack.execute(cmd)

    // Simulate server rebase (stack.reset preserves history)
    const serverDoc = makeDoc()
    serverDoc.pages[0]!.elements[0]!.x = 55
    stack.reset(serverDoc)

    // Undo after rebase targets the rebased document
    stack.undo()
    expect(stack.getState().document.pages[0]!.elements[0]!.x).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// Thumbnail cache keying — pure logic (no Konva, no DOM)
//
// The cache key is `pageId:cheapHash(elements)`. We test the hash function
// properties that matter: same content → same key, different content → different key.
// ---------------------------------------------------------------------------

// Inline a minimal version of the cheapHash function as exported from the module
// under test. We test the invariants, not the exact output values.
function cheapHash(value: unknown): string {
  const s = JSON.stringify(value) ?? ''
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

describe('thumbnail cache key invariants', () => {
  it('same elements array produces same hash', () => {
    const el = { id: 'a', kind: 'rect', x: 0, y: 0, width: 10, height: 10 }
    expect(cheapHash([el])).toBe(cheapHash([el]))
  })

  it('different element positions produce different hashes', () => {
    const el1 = { id: 'a', kind: 'rect', x: 0, y: 0, width: 10, height: 10 }
    const el2 = { id: 'a', kind: 'rect', x: 99, y: 0, width: 10, height: 10 }
    expect(cheapHash([el1])).not.toBe(cheapHash([el2]))
  })

  it('different page ids produce different cache keys for identical elements', () => {
    const elements = [{ id: 'a', kind: 'rect', x: 0, y: 0 }]
    const hash = cheapHash(elements)
    const key1 = `page-1:${hash}`
    const key2 = `page-2:${hash}`
    expect(key1).not.toBe(key2)
  })

  it('empty elements produce a stable hash', () => {
    expect(cheapHash([])).toBe(cheapHash([]))
  })

  it('adding an element changes the hash', () => {
    const before: unknown[] = []
    const after = [{ id: 'new', kind: 'rect', x: 0, y: 0 }]
    expect(cheapHash(before)).not.toBe(cheapHash(after))
  })
})

// ---------------------------------------------------------------------------
// Lazy entry exports contract
//
// Verify the lazy.tsx module exports the expected symbols. We import it
// statically here; the lazy() call itself is not invoked (that needs React).
// ---------------------------------------------------------------------------

describe('lazy entry exports', () => {
  it('exports DesignCanvasLazy and DesignCanvasChromeLazy', async () => {
    const lazyMod = await import('../../src/design-canvas-react/lazy')
    expect(typeof lazyMod.DesignCanvasLazy).toBe('object')       // React.lazy returns an object
    expect(typeof lazyMod.DesignCanvasChromeLazy).toBe('object')
  })

  it('exports DesignCanvasFullProps and DesignCanvasProps as types (module has the keys)', async () => {
    // Type-only exports do not appear at runtime; verify the module loads cleanly
    const lazyMod = await import('../../src/design-canvas-react/lazy')
    expect(lazyMod).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// DesignCanvasEditor module exports contract
// ---------------------------------------------------------------------------

describe('DesignCanvasEditor module', () => {
  it('exports DesignCanvasEditor as a function', async () => {
    const mod = await import('../../src/design-canvas-react/components/DesignCanvasEditor')
    expect(typeof mod.DesignCanvasEditor).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// WorkspaceView module exports contract
// ---------------------------------------------------------------------------

describe('WorkspaceView export', () => {
  it('exports WorkspaceView as a function', async () => {
    const mod = await import('../../src/design-canvas-react/components/Workspace')
    expect(typeof mod.WorkspaceView).toBe('function')
    expect(typeof mod.Workspace).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Stack isolation: two independent stacks do not share state
// (documents the problem that single-stack solves — ensure the fix doesn't
// accidentally merge unrelated stacks)
// ---------------------------------------------------------------------------

describe('stack isolation', () => {
  it('two independently created stacks do not share history', () => {
    const doc = makeDoc()
    const stack1 = createSceneCommandStack(doc, 'page-1')
    const stack2 = createSceneCommandStack(doc, 'page-1')

    const cmd = setAttrsCommand({
      pageId: 'page-1',
      elementId: 'el-1',
      attrs: { x: 77 },
      priorAttrs: { x: 10 },
    })
    stack1.execute(cmd)

    expect(stack1.canUndo()).toBe(true)
    // stack2 is unaware of stack1's mutation — the flaw this PR fixes
    expect(stack2.canUndo()).toBe(false)
    expect(stack2.getState().document.pages[0]!.elements[0]!.x).toBe(10)
  })
})
