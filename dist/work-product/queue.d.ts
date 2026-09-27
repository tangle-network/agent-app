/**
 * The review queue is a PROJECTION, not a store — a client-safe pure fold of
 * existing sources into queue items (the `/missions` events.ts pattern: pure
 * data, re-validation at JSON boundaries). The only genuinely-new durable
 * state behind it is the {@link WorkProductRecord} row and its status
 * machine; everything else reads what already exists:
 *
 *  - intake: a chat thread for the engagement scope with NO record yet
 *  - missing_info: the open record's thread has a PENDING `/interactions` ask
 *  - working: record status `draft` (the live token tail stays on the chat
 *    surface's existing running-turns endpoint — the projection tracks no
 *    live runs, per the reuse-the-primitive invariant)
 *  - ready_for_review / changes_requested / approved / blocked: read directly
 *    off `WorkProductRecord.status` (blocked surfaces its unresolved count)
 */
import { isWorkProductStatus, type WorkProductProvenance, type WorkProductRecord, type WorkProductRef } from './types';
export type ReviewQueueState = 'intake' | 'missing_info' | 'working' | 'ready_for_review' | 'changes_requested' | 'approved' | 'blocked';
/** One row of the review queue projection for an engagement scope */
export interface ReviewQueueItem {
    scopeKey: string;
    state: ReviewQueueState;
    threadId: string | null;
    workProduct?: WorkProductRef & {
        title: string;
        kind: string;
    };
    /** The pending `/interactions` ask parking this scope, when any. */
    pendingAsk?: {
        interactionId: string;
        title: string;
    };
    blockingExceptions: number;
    failedChecks: number;
    provenance?: Pick<WorkProductProvenance, 'profileHash' | 'servingModels'>;
    updatedAt: number;
}
/** An engagement-scoped chat thread — the intake candidate source. Products
 *  that scope threads already carry a scopeKey-style column. */
export interface ReviewQueueThread {
    scopeKey: string;
    threadId: string;
    updatedAt: number;
}
/** A pending `/interactions` ask on a thread (from the existing list
 *  endpoint) — the missing_info source. */
export interface ReviewQueuePendingAsk {
    threadId: string;
    interactionId: string;
    title: string;
}
/** Existing-source inputs the projection folds — no new stores */
export interface ReviewQueueInputs {
    workProducts: readonly WorkProductRecord[];
    /** Engagement threads with no work product yet → intake items. */
    threads?: readonly ReviewQueueThread[];
    /** Pending asks by thread → missing_info override on open records. */
    pendingAsks?: readonly ReviewQueuePendingAsk[];
}
/** Fold the existing sources into queue items, newest first. */
export declare function projectReviewQueue(inputs: ReviewQueueInputs): ReviewQueueItem[];
/** Re-validate one JSON-boundary row into a queue item; null for junk. The
 *  client-side twin of the server projection, for payloads that cross a
 *  fetch boundary. */
export declare function parseReviewQueueItem(raw: unknown): ReviewQueueItem | null;
/** Convenience guard used when a status string crosses a JSON boundary. */
export { isWorkProductStatus };
