/**
 * Undo/redo command stack over immutable `EditorSceneState`.
 *
 * History entries hold COMMANDS (state transforms + durable operations
 * captured at construction), never snapshots. Rebasing the document via
 * `reset()` therefore cannot stale the history: a later undo re-applies the
 * inverse transform to whatever document is current. If the rebase removed an
 * element a historical command targets, that transform throws (fail loud)
 * rather than silently editing the wrong element.
 *
 * `setView` updates volatile view state (zoom/pan/selection/toggles) without
 * touching history — view changes are never undo steps.
 */

import type { SceneDocument } from '../../design-canvas/model'
import type { EditorSceneState, SceneCommand, SceneCommandStack } from '../contracts'

/** Oldest entries are dropped past this bound; redo stack is cleared on execute. */
export const SCENE_COMMAND_HISTORY_LIMIT = 200

/**
 * The base {@link SceneCommandStack} plus the two command-specific recovery
 * primitives the undo/redo persistence path needs. `rollback` (on the base
 * contract) undoes a failed COMMIT; these undo a failed UNDO/REDO persist.
 * Defined here (not on the shared contract) so consumers that take the stack as
 * `ReturnType<typeof createSceneCommandStack>` see them without a contract bump.
 */
export interface SceneCommandStackWithReapply extends SceneCommandStack {
  /**
   * A persisted UNDO rejected: re-apply that command's FORWARD transform (move
   * it redo→undo). Mirrors `rollback`'s command-specific contract — it acts on
   * the captured command, not blindly on the redo-stack top, so an interleaved
   * edit cannot make it re-apply the wrong command. No-op if the command is not
   * the top of the redo stack (a newer edit reshaped history — the next
   * `reset()` reconciles).
   */
  reexecute(command: SceneCommand): void
  /**
   * A persisted REDO rejected: re-apply that command's INVERSE transform (move
   * it undo→redo). The redo-side mirror of `reexecute`. No-op unless the command
   * is the top of the undo stack.
   */
  reundo(command: SceneCommand): void
}

export function createSceneCommandStack(document: SceneDocument, activePageId: string): SceneCommandStackWithReapply {
  let state: EditorSceneState = {
    document,
    activePageId,
    selectedElementIds: [],
    zoom: 1,
    panX: 0,
    panY: 0,
    gridEnabled: false,
    gridSize: 10,
    snapEnabled: true,
    showRulers: true,
    showBleed: false,
  }

  const undoStack: SceneCommand[] = []
  const redoStack: SceneCommand[] = []
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }

  return {
    execute(command: SceneCommand): void {
      state = command.execute(state)
      undoStack.push(command)
      if (undoStack.length > SCENE_COMMAND_HISTORY_LIMIT) {
        undoStack.splice(0, undoStack.length - SCENE_COMMAND_HISTORY_LIMIT)
      }
      redoStack.length = 0
      notify()
    },

    // Both transforms run BEFORE the stacks move: a throwing transform (e.g.
    // missing element after reset()) leaves history and state exactly as they
    // were. The entry is never silently destroyed — the caller can retry after
    // the next server refresh restores the target.
    undo(): SceneCommand {
      const command = undoStack[undoStack.length - 1]
      if (!command) throw new Error('nothing to undo — guard with canUndo() before calling undo()')
      state = command.undo(state)
      undoStack.pop()
      redoStack.push(command)
      notify()
      return command
    },

    redo(): SceneCommand {
      const command = redoStack[redoStack.length - 1]
      if (!command) throw new Error('nothing to redo — guard with canRedo() before calling redo()')
      state = command.execute(state)
      redoStack.pop()
      undoStack.push(command)
      notify()
      return command
    },

    canUndo(): boolean {
      return undoStack.length > 0
    },

    canRedo(): boolean {
      return redoStack.length > 0
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    getState(): EditorSceneState {
      return state
    },

    setView(patch: Partial<Omit<EditorSceneState, 'document'>>): void {
      state = { ...state, ...patch }
      notify()
    },

    // A persisted UNDO rejected: the server still has `command` applied, but the
    // local undo already removed it (and a later execute may have cleared the
    // redo stack). Deterministically re-converge — mirror of `rollback`, in the
    // forward direction: re-apply the command's FORWARD transform to current
    // state and ensure it lives on the undo stack (so a later undo can remove it
    // again). Idempotent: if the command is already on the undo stack (the undo
    // never actually left local history), this is a no-op. For disjoint edits the
    // forward transform commutes past commands executed while the undo was
    // pending, so their net effect is preserved.
    reexecute(command: SceneCommand): void {
      if (undoStack.includes(command)) return
      state = command.execute(state)
      const redoIdx = redoStack.lastIndexOf(command)
      if (redoIdx !== -1) redoStack.splice(redoIdx, 1)
      undoStack.push(command)
      notify()
    },

    // A persisted REDO rejected: the server does NOT have `command` applied, but
    // the local redo just applied it forward and put it on the undo stack.
    // Re-apply its INVERSE and move it to the redo stack — the redo-side mirror
    // of `reexecute`. No-op if the command is not on the undo stack.
    reundo(command: SceneCommand): void {
      const undoIdx = undoStack.lastIndexOf(command)
      if (undoIdx === -1) return
      state = command.undo(state)
      undoStack.splice(undoIdx, 1)
      if (!redoStack.includes(command)) redoStack.push(command)
      notify()
    },

    rollback(command: SceneCommand): void {
      const idx = undoStack.lastIndexOf(command)
      // Command not in history — stale or double-fire rejection handler; no-op.
      if (idx === -1) return

      // Apply the command's inverse against the current state. For non-overlapping
      // edits (different elements or different attributes) this is exact: the
      // inverse commutes freely past all subsequent commands. For overlapping edits
      // on the same attribute the result is defined but not semantically perfect;
      // the persistence layer should trigger an onResyncRequired refetch in that
      // case so the server document reconciles.
      state = command.undo(state)

      // Splice the target command out of the undo stack.
      undoStack.splice(idx, 1)

      // Clear the redo stack: its entries were computed relative to a history that
      // included this command, so they are now stale.
      redoStack.length = 0

      notify()
    },

    /** Rebase onto a server-refreshed document. History survives; selection
     *  drops ids the refresh removed so view state never dangles. */
    reset(newDocument: SceneDocument): void {
      // Collect all live element ids across all pages for selection cleanup
      const liveElementIds = new Set<string>()
      for (const page of newDocument.pages) {
        collectElementIds(page.elements, liveElementIds)
      }
      // If the active page was removed, fall back to the first page
      const activePageExists = newDocument.pages.some((p) => p.id === state.activePageId)
      const activePageId = activePageExists ? state.activePageId : (newDocument.pages[0]?.id ?? state.activePageId)
      state = {
        ...state,
        document: newDocument,
        activePageId,
        selectedElementIds: state.selectedElementIds.filter((id) => liveElementIds.has(id)),
      }
      notify()
    },
  }
}

function collectElementIds(elements: ReturnType<typeof Array.prototype.slice>, ids: Set<string>): void {
  for (const el of elements as Array<{ id: string; kind: string; children?: unknown[] }>) {
    ids.add(el.id)
    if (el.kind === 'group' && Array.isArray(el.children)) {
      collectElementIds(el.children as Array<{ id: string; kind: string; children?: unknown[] }>, ids)
    }
  }
}
