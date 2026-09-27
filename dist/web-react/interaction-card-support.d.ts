/**
 * Shared answer-building + submit plumbing for the interaction cards
 * (question, plan). Client-safe, no React: cards own their state, this owns
 * the wire. Lifted from the gtm-agent fork (the most fix-absorbed of the three
 * product copies), including the 30s submit timeout that keeps a dead route
 * from wedging a card in "Submitting…".
 */
import type { ChatInteraction, ChatInteractionField, ChatInteractionStatus, InteractionAnswers, InteractionData } from './chat-interactions';
/** Status-badge labels for an interaction card. `cancelled`/`expired` read the
 *  same across cards; each card supplies its own verbs for the other states
 *  (a question is answered/declined; a plan is approved/rejected). */
export declare function interactionStatusLabels(labels: {
    pending: string;
    answered: string;
    declined: string;
}): Record<ChatInteractionStatus, string>;
/** Terminal-state notes for an interaction card. The expiry/withdrawal lines
 *  share one shape around the card's noun ("question"/"plan"); any extra notes
 *  (e.g. a plan's `declined` revision line) merge on top. */
export declare function interactionTerminalNotes(noun: string, extra?: Partial<Record<ChatInteractionStatus, string>>): Partial<Record<ChatInteractionStatus, string>>;
/** Define a record mapping field names to objects with optional selected, text, and custom string arrays or values */
export type FieldValues = Record<string, {
    selected?: string[];
    text?: string;
    custom?: string;
}>;
/** Converts acknowledged, persisted answers back into the local field state
 * consumed by the shared cards. Persisted values are authoritative: this is
 * intentionally used only when an interaction carries `answers`, never to
 * guess an answer from the absence of an outstanding sidecar ask. */
export declare function fieldValuesFromAnswers(fields: ChatInteractionField[], answers: InteractionAnswers | undefined): FieldValues;
/** The submitted value for one field, or null when it has no answer yet.
 *
 *  Returns `InteractionAnswers[string]`, not the wider `InteractionData[string]`:
 *  a card reads its value out of a rendered control, so every branch below
 *  yields a plain scalar or string array. `InteractionData` also admits a
 *  one-use `secret_handle` reference, which no control here can produce and
 *  which `onResolved` must never receive — that path persists into the visible
 *  transcript. Declaring the narrow type keeps the handle out by construction
 *  rather than by review. */
export declare function fieldAnswer(field: ChatInteractionField, values: FieldValues): InteractionAnswers[string] | null;
/** All required fields answered → the respond payload; else null (not
 *  submittable yet). Optional unanswered fields are omitted. */
export declare function buildAnswerData(fields: ChatInteractionField[], values: FieldValues): InteractionAnswers | null;
/** Determine if a status is late answerable by checking if it is expired or cancelled */
export declare function isLateAnswerableStatus(status: ChatInteractionStatus): boolean;
/** Secrets must never leave the sidecar answer channel for the visible chat
 *  transcript, so a secret-bearing ask cannot be late-answered. */
export declare function hasSecretField(fields: ChatInteractionField[]): boolean;
/** Renders the late answer as a self-contained chat message: the original
 *  question, its context, and the user's answer(s). */
export declare function lateAnswerMessage(interaction: ChatInteraction, data: InteractionData): string;
/** Define the timeout duration in milliseconds for submitting an interaction */
export declare const INTERACTION_SUBMIT_TIMEOUT_MS = 30000;
/** Provide the timeout message displayed when the agent cannot be reached during interaction submission */
export declare const INTERACTION_SUBMIT_TIMEOUT_MESSAGE = "Could not reach the agent. Try again.";
/** One card submission: which ask, resolved how, with what answers. */
export interface InteractionAnswerSubmission {
    id: string;
    outcome: 'accepted' | 'declined';
    data?: InteractionData;
}
/** Resolve the result of an interaction submission indicating success or failure with details */
export type InteractionSubmitResult = {
    ok: true;
} | {
    ok: false;
    expired: boolean;
    message: string;
};
/** The cards' only side-effect seam: POST one resolution, report the normalized
 *  outcome. Products bind their route URL + routing fields (workspaceId,
 *  threadId, session path param) via `createInteractionAnswerSubmitter` or a
 *  hand-rolled implementation. */
export type SubmitInteractionAnswer = (submission: InteractionAnswerSubmission) => Promise<InteractionSubmitResult>;
/** Extracts the most specific error message a route returned. */
export declare function responseErrorMessage(res: Response): Promise<{
    code?: string;
    message: string;
}>;
/** Define options for submitting interaction answers including URL, body, timeout, and fetch implementation */
export interface InteractionAnswerSubmitterOptions {
    /** The product's answer route (the POST half of `createInteractionAnswerRoute`).
     *  A function when the URL carries the session (e.g. `/api/sessions/${id}/interactions`). */
    url: string | ((submission: InteractionAnswerSubmission) => string);
    /** Extra routing fields merged into the POST body (e.g. workspaceId, threadId). */
    body?: Record<string, unknown> | ((submission: InteractionAnswerSubmission) => Record<string, unknown>);
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}
/**
 * Runs a host-supplied submitter under the CARD's own deadline, and always
 * resolves.
 *
 * `createInteractionAnswerSubmitter` aborts its own fetch, but a product may
 * pass any `SubmitInteractionAnswer` — commonly one wrapping an untimed
 * `fetch`. The deadline cannot live only in the submitter, because what gets
 * stuck is the card: its in-flight guard is cleared by the awaited promise
 * settling, so a submitter that never settles leaves that guard set for the
 * life of the instance — "Submitting…" forever, and no answer can be sent
 * again. A submitter with its own shorter timeout simply wins the race.
 *
 * Rejection is normalized too: a submitter that throws would otherwise escape
 * the click handler as an unhandled rejection, leaving the user with a card
 * that silently did nothing. It becomes a visible, retryable message instead.
 */
export declare function settleInteractionSubmit(run: () => Promise<InteractionSubmitResult>, timeoutMs?: number): Promise<InteractionSubmitResult>;
/**
 * Builds the `SubmitInteractionAnswer` the cards consume: POSTs
 * `{ ...routingFields, id, outcome, data? }` with an abortable timeout and
 * normalizes the outcome. `expired` is the 410 path — the ask is gone
 * (answered elsewhere, timed out, or the session moved on) and the card must
 * flip to the same dead state a cancel event produces.
 */
export declare function createInteractionAnswerSubmitter(options: InteractionAnswerSubmitterOptions): SubmitInteractionAnswer;
