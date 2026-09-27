/**
 * React binding for the assistant panel: owns the reducer, drives the chat SSE
 * stream and the proposal-confirmation call, and persists the thread across
 * reloads. All rendering decisions live in the pure reducer + presentation
 * helpers; this hook is the glue between them and the network.
 */
import { type AssistantState } from "./reducer";
import type { AssistantDeliveryMode, ConnectionRequirement, ConnectRequirementResult, PendingProposal } from "./types";
/** Define options for configuring how the assistant sends messages */
export interface AssistantSendOptions {
    deliveryMode?: AssistantDeliveryMode;
}
/** Host integration callbacks for {@link useAssistantChat}. */
export interface UseAssistantChatOptions {
    /**
     * Called after a workflow-mutating tool (`create_workflow`, `author_workflow`,
     * …) is confirmed successfully — the host re-fetches its workflow list so the
     * result appears without a manual reload. Replaces the in-app cross-module
     * signal the platform used.
     */
    onWorkflowMutation?: () => void;
    /**
     * Called when the user activates a proposal requirement's connect affordance.
     * The host runs whatever connect flow it owns — an OAuth popup, an api-key
     * modal, an app install — and resolves whether the requirement is now
     * satisfied; the card then flips that requirement to connected. Host-agnostic:
     * the assistant never learns how the connection is made, so any host (platform,
     * sandbox, intelligence, …) can supply its own. When omitted, the card falls
     * back to navigating the requirement's connect target (see
     * {@link ProposalCardProps.navigate}).
     */
    onConnectRequirement?: (requirement: ConnectionRequirement) => Promise<ConnectRequirementResult>;
}
/** Define the structure and behavior of an assistant chat session with state, model selection, and message handling */
export interface AssistantChat {
    state: AssistantState;
    /** Proposal ids whose confirmation is currently in flight (for disabling). */
    confirmingIds: ReadonlySet<string>;
    /** The user's selected model slug, or null to use the server default. */
    selectedModel: string | null;
    /** Choose the model for subsequent turns (persisted per user). */
    setModel: (model: string | null) => void;
    send: (message: string, options?: AssistantSendOptions) => void;
    stop: () => void;
    confirm: (proposal: PendingProposal) => Promise<void>;
    cancel: (proposal: PendingProposal) => void;
    /** True when the host supplied an in-place connect handler
     *  ({@link UseAssistantChatOptions.onConnectRequirement}); the proposal card
     *  uses this to offer in-place connect instead of navigating away. */
    canConnectRequirement: boolean;
    /** Run the host's in-place connect for one of a proposal's requirements and,
     *  on success, flip that requirement to connected on the card. Resolves (a
     *  no-op) when no host handler is set or the connect didn't complete. */
    connectRequirement: (proposal: PendingProposal, requirement: ConnectionRequirement) => Promise<void>;
    reset: () => void;
    /** Open an existing thread from history, loading its transcript. */
    switchThread: (threadId: string) => void;
    /** True while a switched-to thread's transcript is loading — the composer is
     *  held closed until it resolves so a turn can't run against hidden context. */
    restoring: boolean;
}
/** Manage assistant chat state and interactions for a given user ID with optional configurations */
export declare function useAssistantChat(userId: string | null, options?: UseAssistantChatOptions): AssistantChat;
