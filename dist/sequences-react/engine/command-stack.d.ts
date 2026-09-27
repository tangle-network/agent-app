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
import type { SequenceTimeline } from '../../sequences/model';
import type { CommandStack } from '../contracts';
/** Oldest entries are dropped past this bound; redo is cleared on execute. */
export declare const COMMAND_HISTORY_LIMIT = 200;
/** Create a command stack managing undo and redo operations for a given timeline */
export declare function createCommandStack(initial: SequenceTimeline): CommandStack;
