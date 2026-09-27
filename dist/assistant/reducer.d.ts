/**
 * Pure state machine driving the assistant panel. Every UI transition — a user
 * message, each streamed SSE event, a stream failure, a confirmed/cancelled
 * proposal, a manual stop — is modeled as an action here, so the panel's
 * behavior can be verified without a DOM or a live stream.
 */
import type { AssistantStreamEvent, ChatMessage, ConnectionRequirementKind, PendingProposal, UsageInfo } from "./types";
type ChatStatus = "idle" | "streaming" | "awaiting_confirm";
export interface AssistantState {
    /** The signed-in user this conversation belongs to. Carried in state so it
     *  moves atomically with the data it labels — persistence keys off it, and a
     *  render whose owner doesn't match the current user is masked (see
     *  `selectVisibleState`), preventing a one-frame cross-account leak. */
    ownerId: string | null;
    /** Persisted across reloads to continue the same server-side thread. */
    threadId: string | null;
    messages: ChatMessage[];
    status: ChatStatus;
    /** Id of the assistant message currently accumulating deltas, if any. Set to
     *  null mid-turn when a tool runs, so the next text delta opens a fresh
     *  assistant bubble — keeping each reasoning segment visually distinct. */
    streamingId: string | null;
    /** Base id for the current turn's assistant bubbles (the `send` assistant id).
     *  Post-tool segments derive a unique id from it; null between turns. */
    streamBaseId: string | null;
    /** How many assistant bubbles the current turn has opened (0 = just the first).
     *  Drives the per-segment bubble id so segments never collide across turns. */
    segmentSeq: number;
    pendingProposals: PendingProposal[];
    /** Cost/balance from the most recently settled turn. */
    usage: UsageInfo | null;
    /** Model slug the current/most-recent turn ran against (from the thread
     *  event), or null before any turn this session. */
    model: string | null;
    /** The current turn's accumulated reasoning/thinking text (reasoning models
     *  stream this before the answer). Shown dim while the answer is still pending;
     *  reset at the start of each turn. Null when the model emits no reasoning. */
    reasoning: string | null;
    error: {
        code: string;
        message: string;
    } | null;
    /** True when the most-recent turn stopped at the per-turn step limit before the
     *  model finished (a partial reply). Drives the one-click "Continue" affordance;
     *  cleared when the next turn starts. */
    capped: boolean;
}
type AssistantAction = {
    type: "send";
    messageId: string;
    assistantId: string;
    text: string;
} | {
    type: "stream";
    event: AssistantStreamEvent;
} | {
    type: "stream_failed";
    error: {
        code: string;
        message: string;
    };
} | {
    type: "proposal_resolved";
    /** The card's canonical identity (the model's tool-call id). */
    callId: string;
    status: ChatMessage | null;
    /** Set on a failed confirmation; null clears any prior error. */
    error: {
        code: string;
        message: string;
    } | null;
} | {
    type: "proposal_retry_failed";
    /** The card to KEEP (a retryable confirm failure — an unconnected
     *  integration). The card stays confirmable; the message is shown on it. */
    callId: string;
    message: string;
} | {
    type: "requirement_connected";
    /** The proposal card whose requirement was just connected (its callId). */
    callId: string;
    /** Identity of the now-connected requirement, matched within the card's
     *  own requirements. `kind` defaults to "integration" (the card's default)
     *  when absent, so a requirement carrying no explicit kind still matches. */
    provider: string;
    kind?: ConnectionRequirementKind;
} | {
    type: "stopped";
} | {
    type: "hydrate";
    ownerId: string | null;
    threadId: string | null;
    messages: ChatMessage[];
} | {
    type: "restore_history";
    ownerId: string | null;
    threadId: string;
    messages: ChatMessage[];
    /** Unconfirmed proposals restored alongside the transcript so a card
     *  survives reload. Empty when none are pending. */
    proposals: PendingProposal[];
} | {
    type: "thread_gone";
    ownerId: string | null;
    threadId: string;
} | {
    type: "history_failed";
    ownerId: string | null;
    threadId: string;
    error: {
        code: string;
        message: string;
    };
} | {
    type: "switch_thread";
    threadId: string;
} | {
    type: "reset";
};
export declare function initialAssistantState(): AssistantState;
/**
 * The state safe to render for `userId`. When the conversation in state belongs
 * to a different user (the single commit between an auth change and the hydrate
 * that follows it), return a fresh empty state instead of the prior user's
 * transcript — so an account's messages and proposals are never shown, even for
 * one frame, under another account.
 */
export declare function selectVisibleState(state: AssistantState, userId: string | null): AssistantState;
export declare function assistantReducer(state: AssistantState, action: AssistantAction): AssistantState;
export {};
