import type { SequenceApplyResult } from '../../sequences/apply'
import type { SequenceOperation } from '../../sequences/operations'
import type { TimelineCommand, TimelineEditorProps } from '../contracts'
import { createCommandStack } from '../engine/command-stack'
const HISTORY_MIRROR_LIMIT = 200

export interface TimelineHistoryEntry {
    command: TimelineCommand
    /** Optimistic ids this command's clip-creating operations minted, in
     *  operation order — the pairing key for id reconciliation. */
    createdLocalIds: string[]
  }

export function createTimelineHistoryHandlers({ clipIdAliasesRef, setCommitError, canWrite, stack,
  historyRef, onApplyOperations }: { clipIdAliasesRef: { current: Map<string, string> };
  setCommitError: (error: string | null) => void; canWrite: boolean;
  stack: ReturnType<typeof createCommandStack>; historyRef: { current: { done: TimelineHistoryEntry[];
  undone: TimelineHistoryEntry[] } }; onApplyOperations: TimelineEditorProps['onApplyOperations'] }) {

  function resolveClipId(clipId: string): string {
    return clipIdAliasesRef.current.get(clipId) ?? clipId
  }

  /** Pair each clip-creating operation with its apply result and record the
   *  local→server alias. Results are index-aligned with operations (the
   *  `applySequenceOperations` contract); a host returning a mismatched array
   *  is a wiring bug surfaced loud, not silently skipped. */
  function reconcileCreatedClipIds(
    operations: SequenceOperation[],
    createdLocalIds: string[],
    results: SequenceApplyResult[] | void,
  ) {
    if (createdLocalIds.length === 0 || !Array.isArray(results)) return
    if (results.length !== operations.length) {
      setCommitError(
        `onApplyOperations returned ${results.length} results for ${operations.length} operations — clip-id reconciliation skipped`,
      )
      return
    }
    let cursor = 0
    operations.forEach((operation, index) => {
      if (operation.type !== 'place_clip' && operation.type !== 'add_caption' && operation.type !== 'split_clip') return
      const localId = createdLocalIds[cursor]
      cursor += 1
      const result = results[index]
      if (localId !== undefined && result !== undefined && result.kind === 'clip') {
        clipIdAliasesRef.current.set(localId, result.clip.id)
      }
    })
  }

  function commitCommand(command: TimelineCommand, createdLocalIds: string[] = []) {
    if (!canWrite) return
    try {
      stack.execute(command)
    } catch (error) {
      setCommitError(error instanceof Error ? error.message : String(error))
      return
    }
    const history = historyRef.current
    const entry: TimelineHistoryEntry = { command, createdLocalIds }
    history.done.push(entry)
    if (history.done.length > HISTORY_MIRROR_LIMIT) history.done.splice(0, history.done.length - HISTORY_MIRROR_LIMIT)
    history.undone = []
    setCommitError(null)
    const operations = command.operations()
    void onApplyOperations(operations)
      .then((results) => reconcileCreatedClipIds(operations, createdLocalIds, results))
      .catch((error: unknown) => {
        // Roll back ONLY when this command is still the newest local edit; if
        // the user already undid or stacked more edits, local rollback would
        // corrupt history — surface the error and let the next server refresh
        // (stack.reset) reconcile.
        const mirror = historyRef.current
        if (mirror.done[mirror.done.length - 1] === entry && stack.canUndo()) {
          stack.undo()
          mirror.done.pop()
        }
        setCommitError(error instanceof Error ? error.message : String(error))
      })
  }

  function undoLast() {
    const history = historyRef.current
    const entry = history.done[history.done.length - 1]
    if (!entry || !stack.canUndo()) return
    try {
      stack.undo()
    } catch (error) {
      // A reset() removed the command's target clip; the stack kept the entry
      // (it may succeed after the next refresh), so the mirror stays too.
      setCommitError(`Undo failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    history.done.pop()
    history.undone.push(entry)
    void onApplyOperations(entry.command.inverseOperations()).catch((error: unknown) => {
      // The undo's persist rejected: the server still has the command applied,
      // so the local undo diverged. Re-redo it ONLY when this entry is still the
      // newest undone edit (mirror commitCommand: still-newest guard); if the
      // user has since stacked more undo/redo, a local re-redo would corrupt
      // history — defer to the next server refresh (stack.reset).
      const mirror = historyRef.current
      if (mirror.undone[mirror.undone.length - 1] === entry && stack.canRedo()) {
        stack.redo()
        mirror.undone.pop()
        mirror.done.push(entry)
      }
      setCommitError(error instanceof Error ? error.message : String(error))
    })
  }

  function redoLast() {
    const history = historyRef.current
    const entry = history.undone[history.undone.length - 1]
    if (!entry || !stack.canRedo()) return
    try {
      stack.redo()
    } catch (error) {
      setCommitError(`Redo failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    history.undone.pop()
    history.done.push(entry)
    const operations = entry.command.operations()
    // A redo of a clip-creating command mints fresh server ids — re-pair them
    // so a later undo deletes the recreated clips, not the stale ones.
    void onApplyOperations(operations)
      .then((results) => reconcileCreatedClipIds(operations, entry.createdLocalIds, results))
      .catch((error: unknown) => {
        // The redo's persist rejected: the server does NOT have the command
        // applied, so the local redo diverged. Re-undo it ONLY when this entry
        // is still the newest done edit (mirror commitCommand:341); else a local
        // re-undo would corrupt history — defer to the next server refresh.
        const mirror = historyRef.current
        if (mirror.done[mirror.done.length - 1] === entry && stack.canUndo()) {
          stack.undo()
          mirror.done.pop()
          mirror.undone.push(entry)
        }
        setCommitError(error instanceof Error ? error.message : String(error))
      })
  }
  return { resolveClipId, reconcileCreatedClipIds, commitCommand, undoLast, redoLast }
}
