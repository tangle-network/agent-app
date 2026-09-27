/**
 * Pure completion-state helpers for an intake payload — the small algebra over
 * the JSON blob the store persists. No I/O: the store reads/writes the row;
 * these functions only build and judge the payload shape, so the same logic
 * runs in the UI, the handlers, and the DB layer without divergence.
 *
 * A payload is `{ graphId, answers, completedAt? }`. It carries the answers
 * and the id of the graph they were collected against, so a later graph
 * revision can detect a stale payload (`graphId` mismatch) rather than
 * silently mixing answers from two question sets.
 */
import type { IntakeAnswers, IntakeAnswerValue, IntakeGraph } from './model';
/** The persisted JSON for one intake (the `payload` column). */
export interface IntakePayload {
    /** The graph id the answers were collected against — guards stale schemas. */
    graphId: string;
    answers: IntakeAnswers;
    /** ISO-8601 instant the intake was completed, or undefined while in progress. */
    completedAt?: string;
}
/** An empty payload for a fresh intake against `graph`. */
export declare function emptyPayload(graph: IntakeGraph): IntakePayload;
/** A copy of `payload` with one answer set (does not mutate the input). */
export declare function withAnswer(payload: IntakePayload, questionId: string, value: IntakeAnswerValue): IntakePayload;
/**
 * True when the payload's answers complete the graph AND the payload was
 * collected against THIS graph. A `graphId` mismatch is never "complete" —
 * the answers belong to a different question set and must be re-collected.
 */
export declare function payloadComplete(graph: IntakeGraph, payload: IntakePayload): boolean;
/** True when the payload was collected against a DIFFERENT graph revision. */
export declare function payloadIsStale(graph: IntakeGraph, payload: IntakePayload): boolean;
/**
 * Stamp the payload complete at `at` (default now). Returns a copy; pure. The
 * caller has already checked `payloadComplete` — this only records the instant.
 */
export declare function markComplete(payload: IntakePayload, at?: Date): IntakePayload;
