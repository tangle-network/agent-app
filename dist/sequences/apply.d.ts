/**
 * Maps one validated `SequenceOperation` to `SequenceStore` calls and reports
 * what changed. Each call re-validates its single operation against the
 * provided timeline — a dispatcher that skips batch validation still cannot
 * reach the store with an invalid write. The timeline must be the CURRENT
 * state: dispatchers applying a batch refresh it between operations so later
 * operations can reference entities earlier ones created.
 *
 * Split assumes source frames advance 1:1 with sequence frames (the model
 * addresses source in/out points at sequence fps); time-remapped clips are
 * outside this operation vocabulary.
 */
import type { SequenceClip, SequenceExportRecord, SequenceMeta, SequenceTimeline, SequenceTrack } from './model';
import type { SequenceOperation } from './operations';
import type { SequenceStore } from './store';
import type { SequenceOperationContext } from './validate';
/**
 * The entity an operation changed, for the MCP layer to serialize back to the
 * agent. Conventions for multi-entity operations:
 * - `split_clip` returns the newly created second half (the first half is the
 *   original clip id with a shortened duration).
 * - `delete_clip` returns the pre-delete clip snapshot.
 */
export type SequenceApplyResult = {
    kind: 'clip';
    clip: SequenceClip;
} | {
    kind: 'track';
    track: SequenceTrack;
} | {
    kind: 'export';
    record: SequenceExportRecord;
} | {
    kind: 'sequence';
    sequence: SequenceMeta;
};
/**
 * The batch path every dispatcher (the MCP tools, a product's editor
 * persistence route) funnels through: fetch the timeline, validate the WHOLE
 * batch against pre-state, then apply in order with a timeline refresh between
 * operations — later operations must see earlier writes (the static-validation
 * boundary in ./validate).
 *
 * Atomicity contract: validation throws (before the first store write) leave
 * the sequence untouched. Store-layer throws after at least one successful
 * write leave a prefix-committed state — operations 1..N-1 are persisted,
 * operations N..end are not. The store is non-transactional (SQLite D1);
 * callers that receive a partial-commit throw must treat the result as partial
 * success, not a full rollback. Decision-log rows are the caller's job: the
 * MCP layer records `agent_edit`, an editor route records `human_edit`.
 */
export declare function applySequenceOperations(store: SequenceStore, operations: SequenceOperation[], ctx: SequenceOperationContext): Promise<SequenceApplyResult[]>;
/** Apply a sequence operation to update the store and timeline asynchronously */
export declare function applySequenceOperation(store: SequenceStore, timeline: SequenceTimeline, op: SequenceOperation, ctx: SequenceOperationContext): Promise<SequenceApplyResult>;
