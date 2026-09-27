import { type InteractionAnswerSubmission, type InteractionAnswerSubmitterOptions, type SubmitInteractionAnswer } from './interaction-card-support';
/** Manage storage and retrieval of interaction attempt keys by interaction and submission identifiers */
export interface InteractionAttemptStore {
    get(interactionId: string, submissionSignature: string): string | null;
    set(interactionId: string, submissionSignature: string, attemptKey: string): void;
    delete(interactionId: string, submissionSignature: string): void;
}
/** Create a session-based store to manage interaction attempts using provided storage and optional namespace */
export declare function createSessionInteractionAttemptStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, namespace?: string): InteractionAttemptStore;
/** Create an in-memory store to manage interaction attempts keyed by ID and signature */
export declare function createMemoryInteractionAttemptStore(): InteractionAttemptStore;
/** Generate a stable string signature from an interaction answer submission */
export declare function interactionSubmissionSignature(submission: InteractionAnswerSubmission): string;
/** Define options for submitting durable interaction answers with attempt tracking and optional key creation */
export interface DurableInteractionAnswerSubmitterOptions extends InteractionAnswerSubmitterOptions {
    attempts: InteractionAttemptStore;
    createAttemptKey?: () => string;
}
/** Answer submitter for a durable interaction route. One opaque attempt key is
 * retained for an ambiguous transport/5xx result and reused after reload. A
 * changed answer has a different signature and therefore a new attempt. */
export declare function createDurableInteractionAnswerSubmitter(options: DurableInteractionAnswerSubmitterOptions): SubmitInteractionAnswer;
