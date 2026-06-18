/**
 * Rollback correctness under pending-save interleaving.
 *
 * Both Workspace.tsx persist() and DesignCanvas.tsx useCommitCommand use
 * stack.rollback(command) to undo a failed save without disturbing commands
 * the user executed while the save was in-flight.
 *
 * Tests are pure stack-level — no Konva, no React, no DOM.
 *
 * Section A — "before fix" evidence: demonstrates the broken patterns that
 *   were replaced. Uses inline simulations of the old code so the breakage is
 *   visible in test output independent of source changes.
 *
 * Section B — stack.rollback(command) API: correctness assertions against the
 *   new implementation. These must all pass after the fix.
 */

import { describe, expect, it } from 'vitest'
import { createSceneCommandStack } from '../../src/design-canvas-react/engine/command-stack'
import { setAttrsCommand } from '../../src/design-canvas-react/engine/commands'
import { createEmptyDocument } from '../../src/design-canvas/model'
import type { SceneDocument, SceneElement } from '../../src/design-canvas/model'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDoc(): SceneDocument {
  const doc = createEmptyDocument('Test', { width: 1000, height: 800 })
  doc.pages[0]!.elements = [
    {
      id: 'el-1',
      kind: 'rect',
      name: 'Rect 1',
      x: 10,
      y: 20,
      rotation: 0,
      opacity: 1,
      locked: false,
      visible: true,
      width: 100,
      height: 50,
      fill: '#ff0000',
    } as SceneElement,
    {
      id: 'el-2',
      kind: 'rect',
      name: 'Rect 2',
      x: 200,
      y: 200,
      rotation: 0,
      opacity: 1,
      locked: false,
      visible: true,
      width: 100,
      height: 50,
      fill: '#0000ff',
    } as SceneElement,
  ]
  return doc
}

function pageId(doc: SceneDocument): string {
  return doc.pages[0]!.id
}

// ---------------------------------------------------------------------------
// Section A — Pre-fix broken patterns (inline simulation, not production code)
//
// These tests confirm that the OLD code patterns are broken. They simulate the
// exact rollback shapes that existed before the fix so the evidence is durable
// even if someone reads this file without checking git blame.
// ---------------------------------------------------------------------------

describe('Finding 1 — pre-fix evidence: synthetic rollback command corrupts undo history', () => {
  /**
   * Old Workspace.tsx persist() pattern (removed by this PR):
   *   stack.execute(command)
   *   catch => stack.execute({ execute: s => command.undo(s), ... })
   *
   * This pushes TWO entries onto the undo stack and clears redo. After a
   * failed save the user sees "Undo" available, and invoking it re-applies
   * the failed change.
   */
  function persistWithSyntheticRollback(
    stack: ReturnType<typeof createSceneCommandStack>,
    command: Parameters<typeof stack.execute>[0],
  ) {
    stack.execute(command)
    // Simulate the rejection handler using the OLD broken pattern.
    stack.execute({
      label: 'rollback',
      execute: (s) => command.undo(s),
      undo: (s) => command.execute(s),
      operations: () => command.inverseOperations(),
      inverseOperations: () => command.operations(),
    })
  }

  it('synthetic rollback leaves canUndo() true — the user can re-trigger the failed change', () => {
    const doc = makeDoc()
    const stack = createSceneCommandStack(doc, pageId(doc))

    const cmd = setAttrsCommand({
      pageId: pageId(doc),
      elementId: 'el-1',
      attrs: { x: 99 },
      priorAttrs: { x: 10 },
    })

    persistWithSyntheticRollback(stack, cmd)

    // Document value is correct (the synthetic rollback does invert the attrs).
    expect(stack.getState().document.pages[0]!.elements[0]!.x).toBe(10)

    // BUG: canUndo() is true — the undo stack holds the 'rollback' command.
    // Invoking undo would push the failed change back (x → 99).
    expect(stack.canUndo()).toBe(true) // proves the bug exists
  })

  it('synthetic rollback: one stack.undo() call re-applies the failed change', () => {
    const doc = makeDoc()
    const stack = createSceneCommandStack(doc, pageId(doc))

    const cmd = setAttrsCommand({
      pageId: pageId(doc),
      elementId: 'el-1',
      attrs: { x: 99 },
      priorAttrs: { x: 10 },
    })

    persistWithSyntheticRollback(stack, cmd)

    // Invoking undo re-applies the failed change.
    stack.undo()
    expect(stack.getState().document.pages[0]!.elements[0]!.x).toBe(99) // BUG: failed change is back
  })
})

describe('Finding 2 — pre-fix evidence: stack.undo() in the rejection handler undoes the WRONG command', () => {
  /**
   * Old DesignCanvas.tsx useCommitCommand rejection handler (removed by this PR):
   *   if (stack.canUndo()) stack.undo()
   *
   * When the user executes commands B, C after A's save is in-flight,
   * stack.undo() undoes C (the newest), not A (the failed one).
   */
  function commitWithBlindUndo(
    stack: ReturnType<typeof createSceneCommandStack>,
    command: Parameters<typeof stack.execute>[0],
    simulateReject: () => void,
  ) {
    stack.execute(command)
    // Return a function that simulates the rejection: calls the OLD handler.
    return () => {
      simulateReject()
      if (stack.canUndo()) {
        try { stack.undo() } catch { /* ignore */ }
      }
    }
  }

  it('blind stack.undo() on rejection undoes the newest command (B), not the failed one (A)', () => {
    const doc = makeDoc()
    const stack = createSceneCommandStack(doc, pageId(doc))

    const cmdA = setAttrsCommand({
      pageId: pageId(doc),
      elementId: 'el-1',
      attrs: { x: 99 },
      priorAttrs: { x: 10 },
    })

    const cmdB = setAttrsCommand({
      pageId: pageId(doc),
      elementId: 'el-2',
      attrs: { x: 300 },
      priorAttrs: { x: 200 },
    })

    const rejectA = commitWithBlindUndo(stack, cmdA, () => { /* rejection fires */ })
    stack.execute(cmdB) // interleaved edit while A's save is pending
    rejectA()           // A rejects — old handler calls stack.undo()

    // After the blind undo: A's effect is still present (el-1 at 99),
    // and B's effect is gone (el-2 at 200) — the WRONG command was undone.
    const el1 = stack.getState().document.pages[0]!.elements.find((e: SceneElement) => e.id === 'el-1')!
    const el2 = stack.getState().document.pages[0]!.elements.find((e: SceneElement) => e.id === 'el-2')!

    expect(el1.x).toBe(99)   // BUG: A's failed effect is still present
    expect(el2.x).toBe(200)  // BUG: B's valid effect was undone
  })
})

// ---------------------------------------------------------------------------
// Section B — stack.rollback(command): correctness assertions (must all pass)
// ---------------------------------------------------------------------------

describe('stack.rollback(command) — correct rollback API', () => {
  it('rollback(A) with no interleaved commands leaves undo stack empty and restores doc', () => {
    const doc = makeDoc()
    const stack = createSceneCommandStack(doc, pageId(doc))

    const cmdA = setAttrsCommand({
      pageId: pageId(doc),
      elementId: 'el-1',
      attrs: { x: 99 },
      priorAttrs: { x: 10 },
    })

    stack.execute(cmdA)
    stack.rollback(cmdA)

    expect(stack.canUndo()).toBe(false)
    expect(stack.canRedo()).toBe(false)
    expect(stack.getState().document.pages[0]!.elements[0]!.x).toBe(10)
  })

  it('rollback(A) with interleaved B preserves B and splices A from history', () => {
    const doc = makeDoc()
    const stack = createSceneCommandStack(doc, pageId(doc))

    const cmdA = setAttrsCommand({
      pageId: pageId(doc),
      elementId: 'el-1',
      attrs: { x: 99 },
      priorAttrs: { x: 10 },
    })

    const cmdB = setAttrsCommand({
      pageId: pageId(doc),
      elementId: 'el-2',
      attrs: { x: 300 },
      priorAttrs: { x: 200 },
    })

    stack.execute(cmdA)
    stack.execute(cmdB)
    stack.rollback(cmdA)

    const el1 = stack.getState().document.pages[0]!.elements.find((e: SceneElement) => e.id === 'el-1')!
    const el2 = stack.getState().document.pages[0]!.elements.find((e: SceneElement) => e.id === 'el-2')!

    expect(el1.x).toBe(10)   // A removed
    expect(el2.x).toBe(300)  // B preserved

    // Undo stack has exactly B: undoing it reverts el-2 to 200.
    expect(stack.canUndo()).toBe(true)
    stack.undo()
    const el2After = stack.getState().document.pages[0]!.elements.find((e: SceneElement) => e.id === 'el-2')!
    expect(el2After.x).toBe(200)
    expect(stack.canUndo()).toBe(false)
  })

  it('rollback(A) when A is not in the undo stack is a safe no-op', () => {
    const doc = makeDoc()
    const stack = createSceneCommandStack(doc, pageId(doc))

    const cmdA = setAttrsCommand({
      pageId: pageId(doc),
      elementId: 'el-1',
      attrs: { x: 99 },
      priorAttrs: { x: 10 },
    })

    const cmdB = setAttrsCommand({
      pageId: pageId(doc),
      elementId: 'el-1',
      attrs: { x: 50 },
      priorAttrs: { x: 10 },
    })

    // cmdA was never executed — simulates a stale/double-fire rejection handler.
    stack.execute(cmdB)
    const xBefore = stack.getState().document.pages[0]!.elements[0]!.x

    stack.rollback(cmdA)

    // cmdB's effect must be untouched.
    expect(stack.getState().document.pages[0]!.elements[0]!.x).toBe(xBefore)
    expect(stack.canUndo()).toBe(true) // cmdB is still undoable
  })

  it('rollback(A) is idempotent — double-fire does not corrupt state', () => {
    const doc = makeDoc()
    const stack = createSceneCommandStack(doc, pageId(doc))

    const cmdA = setAttrsCommand({
      pageId: pageId(doc),
      elementId: 'el-1',
      attrs: { x: 99 },
      priorAttrs: { x: 10 },
    })

    stack.execute(cmdA)
    stack.rollback(cmdA)
    // Second call: A is no longer in the stack — must be a safe no-op.
    stack.rollback(cmdA)

    expect(stack.canUndo()).toBe(false)
    expect(stack.getState().document.pages[0]!.elements[0]!.x).toBe(10)
  })

  it('rollback clears the redo stack to avoid stale entries', () => {
    const doc = makeDoc()
    const stack = createSceneCommandStack(doc, pageId(doc))

    const cmdA = setAttrsCommand({
      pageId: pageId(doc),
      elementId: 'el-1',
      attrs: { x: 99 },
      priorAttrs: { x: 10 },
    })

    const cmdB = setAttrsCommand({
      pageId: pageId(doc),
      elementId: 'el-1',
      attrs: { x: 50 },
      priorAttrs: { x: 99 },
    })

    stack.execute(cmdA)
    stack.execute(cmdB)
    stack.undo()              // redo stack now has [B]
    expect(stack.canRedo()).toBe(true)

    // rollback(A) must clear the redo stack because B's redo entry is stale.
    stack.rollback(cmdA)
    expect(stack.canRedo()).toBe(false)
  })

  it('#5 reexecute(undone) re-applies the right command when an edit interleaved before the undo rejected', () => {
    // Interleave repro: user executes A, undoes A, then makes a NEW edit B while
    // A's UNDO persist is in-flight. A's undo then REJECTS. The OLD recovery
    // (blind stack.canRedo()/redo()) would re-redo whatever sits on the redo
    // top — but B's execute cleared the redo stack, so canRedo() is false and
    // A's forward state is LOST (divergence from the server, which rejected the
    // undo and still holds A). reexecute(A) deterministically re-applies A.
    const doc = makeDoc()
    const stack = createSceneCommandStack(doc, pageId(doc))

    const cmdA = setAttrsCommand({
      pageId: pageId(doc),
      elementId: 'el-1',
      attrs: { x: 99 },
      priorAttrs: { x: 10 },
    })
    const cmdB = setAttrsCommand({
      pageId: pageId(doc),
      elementId: 'el-2',
      attrs: { x: 300 },
      priorAttrs: { x: 200 },
    })

    stack.execute(cmdA) // el-1 -> 99
    const undone = stack.undo() // local undo of A: el-1 -> 10, A on redo stack
    expect(undone).toBe(cmdA)
    // Interleaved edit B lands while A's undo persist is pending. execute()
    // clears the redo stack, so a blind canRedo() is now false.
    stack.execute(cmdB) // el-2 -> 300
    expect(stack.canRedo()).toBe(false)

    // A's undo persist REJECTS. The server still has A applied (it rejected the
    // undo). reexecute(A) must re-apply A's forward state so local re-converges.
    stack.reexecute(cmdA)

    const el1 = stack.getState().document.pages[0]!.elements.find((e: SceneElement) => e.id === 'el-1')!
    const el2 = stack.getState().document.pages[0]!.elements.find((e: SceneElement) => e.id === 'el-2')!
    expect(el1.x).toBe(99) // A re-applied — converged with the server
    expect(el2.x).toBe(300) // B preserved, not double-applied or dropped
  })

  it('#5 reexecute is idempotent — a no-op when the command is already on the undo stack', () => {
    // The command is still applied locally (the undo never left history, or a
    // double-fire rejection handler). reexecute must not re-apply it a second
    // time (which would double the forward transform).
    const doc = makeDoc()
    const stack = createSceneCommandStack(doc, pageId(doc))
    const cmdA = setAttrsCommand({ pageId: pageId(doc), elementId: 'el-1', attrs: { x: 99 }, priorAttrs: { x: 10 } })
    stack.execute(cmdA) // el-1 -> 99, cmdA on the undo stack
    const before = stack.getState().document.pages[0]!.elements[0]!.x
    expect(before).toBe(99)
    stack.reexecute(cmdA)
    expect(stack.getState().document.pages[0]!.elements[0]!.x).toBe(99) // not doubled
    expect(stack.canUndo()).toBe(true)
  })

  it('#5 non-interleaved undo reject reverts exactly as before via reexecute', () => {
    // With no interleaving, reexecute(A) restores the forward state the failed
    // undo tried to remove — the same net result the old blind redo produced.
    const doc = makeDoc()
    const stack = createSceneCommandStack(doc, pageId(doc))
    const cmdA = setAttrsCommand({ pageId: pageId(doc), elementId: 'el-1', attrs: { x: 99 }, priorAttrs: { x: 10 } })
    stack.execute(cmdA)
    stack.undo() // el-1 -> 10
    expect(stack.getState().document.pages[0]!.elements[0]!.x).toBe(10)
    stack.reexecute(cmdA) // undo rejected -> re-apply forward
    expect(stack.getState().document.pages[0]!.elements[0]!.x).toBe(99)
    expect(stack.canUndo()).toBe(true)
    expect(stack.canRedo()).toBe(false)
  })

  it('#5 reundo restores the inverse after a redo persist rejects', () => {
    // Redo-side mirror: execute A, undo A, redo A (el-1 -> 99 again), then the
    // redo persist rejects. reundo(A) re-applies A's inverse (el-1 -> 10).
    const doc = makeDoc()
    const stack = createSceneCommandStack(doc, pageId(doc))
    const cmdA = setAttrsCommand({ pageId: pageId(doc), elementId: 'el-1', attrs: { x: 99 }, priorAttrs: { x: 10 } })
    stack.execute(cmdA)
    stack.undo()
    const redone = stack.redo() // el-1 -> 99, A back on undo stack
    expect(redone).toBe(cmdA)
    stack.reundo(cmdA) // redo rejected -> re-apply inverse
    expect(stack.getState().document.pages[0]!.elements[0]!.x).toBe(10)
    expect(stack.canRedo()).toBe(true)
  })

  it('rollback(B) when A and B are both in the stack removes only B', () => {
    const doc = makeDoc()
    const stack = createSceneCommandStack(doc, pageId(doc))

    const cmdA = setAttrsCommand({
      pageId: pageId(doc),
      elementId: 'el-1',
      attrs: { x: 99 },
      priorAttrs: { x: 10 },
    })

    const cmdB = setAttrsCommand({
      pageId: pageId(doc),
      elementId: 'el-2',
      attrs: { x: 300 },
      priorAttrs: { x: 200 },
    })

    stack.execute(cmdA)
    stack.execute(cmdB)
    stack.rollback(cmdB)

    const el1 = stack.getState().document.pages[0]!.elements.find((e: SceneElement) => e.id === 'el-1')!
    const el2 = stack.getState().document.pages[0]!.elements.find((e: SceneElement) => e.id === 'el-2')!

    expect(el1.x).toBe(99)   // A still applied
    expect(el2.x).toBe(200)  // B removed

    // Undo stack has exactly A
    expect(stack.canUndo()).toBe(true)
    stack.undo()
    const el1After = stack.getState().document.pages[0]!.elements.find((e: SceneElement) => e.id === 'el-1')!
    expect(el1After.x).toBe(10)
    expect(stack.canUndo()).toBe(false)
  })
})
