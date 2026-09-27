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
import type { SceneDocument } from '../../design-canvas/model';
import type { SceneCommand, SceneCommandStack } from '../contracts';
/** Oldest entries are dropped past this bound; redo stack is cleared on execute. */
export declare const SCENE_COMMAND_HISTORY_LIMIT = 200;
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
    reexecute(command: SceneCommand): void;
    /**
     * A persisted REDO rejected: re-apply that command's INVERSE transform (move
     * it undo→redo). The redo-side mirror of `reexecute`. No-op unless the command
     * is the top of the undo stack.
     */
    reundo(command: SceneCommand): void;
}
/** Create a command stack for scene editing with reapply capabilities based on the given document and page ID */
export declare function createSceneCommandStack(document: SceneDocument, activePageId: string): SceneCommandStackWithReapply;
