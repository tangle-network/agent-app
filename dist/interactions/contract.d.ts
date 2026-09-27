import { type InteractionData, type InteractionField, type InteractionOutcome, type InteractionRequest } from '@tangle-network/agent-interface';
export type { InteractionData, InteractionOutcome, InteractionRequest };
/** Sidecar → client: the agent raised an ask; data = `{ request }`. */
export declare const INTERACTION_EVENT: 'interaction';
/** Sidecar → client: the ask was withdrawn; data = `{ id, reason? }`. */
export declare const INTERACTION_CANCEL_EVENT: 'interaction.cancel';
/** An ask was answered; data = `{ id, status }`. In the wire contract so a
 *  server broadcast and a client-local mark share one event name. */
export declare const INTERACTION_RESOLVED_EVENT: 'interaction.resolved';
/** Resolve if the given interaction kind is renderable within the application context */
export declare function isRenderableInteractionKind(kind: string): boolean;
/** Answer/field keys the sidecar will accept: identifier-safe and never a
 *  prototype-pollution vector. */
export declare function isSafeInteractionFieldKey(key: string): boolean;
/** Extract select-type interaction fields and optionally allow custom values */
export type ChatSelectField = Extract<InteractionField, {
    type: 'select';
}>;
/**
 * A field the user types free text into, which may declare the longest answer
 * its answer route will accept — so a card can stop the typing rather than let
 * the route reject it.
 *
 * Both `text` and `secret`, which is why this is not `ChatTextField`: unlike
 * `ChatSelectField`, it does not name a single `type` literal. They render
 * differently (a textarea vs a password input) and are grouped only by the one
 * property that matters here — an answer whose length can run past what the
 * route takes.
 *
 * The request author chooses this value; omission means the shared contract
 * imposes no length limit.
 */
export type ChatFreeTextField = Extract<InteractionField, {
    type: 'text' | 'secret';
}>;
/** The shared field contract under the UI-facing name used by this package. */
export type ChatInteractionField = InteractionField;
/** The shared request contract under the wire-facing name used by this package. */
export type InteractionRequestWire = InteractionRequest;
/** Define possible statuses representing the state of a chat interaction */
export type ChatInteractionStatus = 'pending' | 'answered' | 'declined' | 'cancelled' | 'expired';
/** Accepted field selections keyed by answer-spec field name. */
/** Accepted answer values. Select fields historically used `string[]`; the
 * wider scalar union is additive and lets durable stores preserve text,
 * numeric, and boolean answer fields without coercion. */
export type InteractionAnswerValue = string | number | boolean | string[];
/** Map interaction identifiers to their corresponding answer values */
export type InteractionAnswers = Record<string, InteractionAnswerValue>;
/** Resolve the result of parsing interaction answers with success status and corresponding data or error message */
export type ParseInteractionAnswersResult = {
    succeeded: true;
    value: InteractionAnswers;
} | {
    succeeded: false;
    error: string;
};
/** Strictly validates and copies persisted answer selections. */
export declare function parseInteractionAnswers(value: unknown): ParseInteractionAnswersResult;
/** The client/persisted view of one ask. `fields` come verbatim off the wire. */
export interface ChatInteraction {
    id: string;
    kind: string;
    title: string;
    body?: string;
    fields: ChatInteractionField[];
    status: ChatInteractionStatus;
    /** Accepted selections, restored with the transcript after reload. */
    answers?: InteractionAnswers;
    /** Set when status came from an `interaction.cancel` (e.g. "timeout"). */
    cancelReason?: string;
}
/** Resolve if the interaction status is a terminal state excluding pending */
export declare function isTerminalInteractionStatus(status: ChatInteractionStatus): boolean;
/** Statuses only move forward (pending → terminal); a replayed/stale `pending`
 *  must never resurrect a resolved card. */
export declare function canTransitionInteractionStatus(from: ChatInteractionStatus, to: ChatInteractionStatus): boolean;
/** Maps an `interaction.cancel` reason to the card's terminal status. */
export declare function cancelStatusFor(reason: string | undefined): ChatInteractionStatus;
/** Content identity for duplicate safety nets. Excludes volatile ids/statuses. */
export declare function questionInteractionContentSignature(interaction: ChatInteraction): string | null;
/** Remove duplicate question interactions based on their content signature to ensure uniqueness */
export declare function dedupeQuestionInteractionsByContent(interactions: ChatInteraction[]): ChatInteraction[];
/** Resolve interaction parsing outcome as success with value or failure with error message */
export type ParseInteractionResult = {
    succeeded: true;
    value: InteractionRequestWire;
} | {
    succeeded: false;
    error: string;
};
/** Parses an `interaction` event's data (`{ request }`) with the shared schema. */
export declare function parseInteractionRequest(data: Record<string, unknown> | undefined): ParseInteractionResult;
/** Describe data required to cancel an interaction including its identifier and optional reason */
export interface InteractionCancelData {
    id: string;
    reason?: string;
}
/** Parse interaction cancel data and return success status with parsed value or error message */
export declare function parseInteractionCancel(data: Record<string, unknown> | undefined): {
    succeeded: true;
    value: InteractionCancelData;
} | {
    succeeded: false;
    error: string;
};
/** Determine if a chat interaction field allows free text input */
export declare function fieldAcceptsFreeText(field: ChatInteractionField): boolean;
/** Define the structure for delivering answers linked to a specific chat interaction and field */
export interface ComposerAnswerDelivery {
    interactionId: string;
    field: ChatInteractionField;
}
/** One delivery per pending ask: the first free-text-capable field, else the
 *  first field. Zero-field asks are skipped (nothing to carry the text). */
export declare function composerAnswerDeliveries(pending: ChatInteraction[]): ComposerAnswerDelivery[];
/** Shapes composer text into the respond payload for the routed field
 *  (select answers are string arrays on the wire; text answers are strings). */
export declare function composerAnswerData(field: ChatInteractionField, text: string): InteractionData;
/** Generate a unique key string for an interaction using the given identifier */
export declare function interactionPartKey(id: string): string;
/** Generate a unique key string for a notice using the given identifier */
export declare function noticePartKey(id: string): string;
/** Define specific string literals representing different kinds of notices */
export type NoticeKind = 'warning' | 'auto-declined';
/**
 * Persisted-part shapes the codecs below produce — the SAME rows
 * `/chat-store`'s `ChatInteractionPart`/`ChatNoticePart` store, typed at the
 * source so a product pushing them into a `ChatMessagePart[]` transcript needs
 * no cast. Type aliases (not interfaces) on purpose: the implicit index
 * signature keeps them assignable to the `Record<string, unknown>` these
 * codecs previously returned, so existing consumers stay source-compatible.
 */
export type InteractionPersistedPart = {
    type: 'interaction';
    id: string;
    kind: string;
    title: string;
    body?: string;
    answerSpec: {
        fields: ChatInteractionField[];
    };
    status: ChatInteractionStatus;
    answers?: InteractionAnswers;
    cancelReason?: string;
};
/** Define a persisted notice part with type, id, kind, and text properties */
export type NoticePersistedPart = {
    type: 'notice';
    id: string;
    noticeKind: NoticeKind;
    text: string;
};
/** Builds the persisted/streamed `notice` part — a one-line transcript notice
 *  explaining an out-of-band event (warning, auto-declined interaction). */
export declare function noticePart(noticeKind: NoticeKind, id: string, text: string): NoticePersistedPart;
/** Reads a wire request into the client's pending `ChatInteraction`. */
export declare function interactionFromWireRequest(request: InteractionRequestWire): ChatInteraction;
/** Builds the persisted/streamed `interaction` part from a wire request. */
export declare function interactionToPersistedPart(request: InteractionRequestWire, status: ChatInteractionStatus, cancelReason?: string, answers?: InteractionAnswers): InteractionPersistedPart;
/** Stamps accepted values onto matching persisted interaction parts without
 * mutating the caller's transcript or answer maps. */
export declare function stampInteractionAnswers(parts: Array<Record<string, unknown>>, answersByInteractionId: Readonly<Record<string, InteractionAnswers>>): Array<Record<string, unknown>>;
/** Reads a persisted/streamed `interaction` part back into a `ChatInteraction`.
 *  Returns null (caller logs) when the part is not one of ours. */
export declare function persistedPartToInteraction(part: Record<string, unknown>): ChatInteraction | null;
