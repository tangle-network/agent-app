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

export function createSceneCommandStack(document: SceneDocument, activePageId: string): SceneCommandStack {
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
