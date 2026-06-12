/**
 * Undo/redo command stack over immutable `EditorTimelineState`.
 *
 * Invariant that makes `reset()` safe: history entries hold COMMANDS — each a
 * pair of state transforms plus the durable operations captured at
 * construction — never state snapshots. Rebasing the timeline from a server
 * refresh therefore cannot stale the history: a later undo re-applies the
 * command's inverse transform to whatever timeline is current. If a rebase
 * removed a clip a historical command targets, that command's transform throws
 * (fail loud) rather than silently editing the wrong clip — the host decides
 * whether to drop history at that point.
 */

import type { SequenceTimeline } from '../../sequences/model'
import type { CommandStack, EditorTimelineState, TimelineCommand } from '../contracts'

/** Oldest entries are dropped past this bound; redo is cleared on execute. */
export const COMMAND_HISTORY_LIMIT = 200

export function createCommandStack(initial: SequenceTimeline): CommandStack {
  /** View fields start at their neutral values; the host layer owns volatile
   *  view state and treats these as initials, not a live channel. */
  let state: EditorTimelineState = {
    timeline: initial,
    playheadFrame: 0,
    selectedClipIds: [],
    zoom: 1,
    scrollLeft: 0,
  }
  const undoStack: TimelineCommand[] = []
  const redoStack: TimelineCommand[] = []
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }

  return {
    execute(command: TimelineCommand): void {
      state = command.execute(state)
      undoStack.push(command)
      if (undoStack.length > COMMAND_HISTORY_LIMIT) {
        undoStack.splice(0, undoStack.length - COMMAND_HISTORY_LIMIT)
      }
      redoStack.length = 0
      notify()
    },

    undo(): void {
      const command = undoStack.pop()
      if (!command) throw new Error('nothing to undo — guard with canUndo() before calling undo()')
      state = command.undo(state)
      redoStack.push(command)
      notify()
    },

    redo(): void {
      const command = redoStack.pop()
      if (!command) throw new Error('nothing to redo — guard with canRedo() before calling redo()')
      state = command.execute(state)
      undoStack.push(command)
      notify()
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

    getState(): EditorTimelineState {
      return state
    },

    /** Rebase onto a server-refreshed timeline. History survives (see module
     *  header); selection drops ids the refresh removed and the playhead
     *  clamps into the new duration so view state never dangles. */
    reset(timeline: SequenceTimeline): void {
      const liveClipIds = new Set(timeline.clips.map((clip) => clip.id))
      state = {
        ...state,
        timeline,
        playheadFrame: Math.max(0, Math.min(state.playheadFrame, timeline.sequence.durationFrames - 1)),
        selectedClipIds: state.selectedClipIds.filter((id) => liveClipIds.has(id)),
      }
      notify()
    },
  }
}
