/**
 * useChatInteractions — the interaction-state wiring every consumer of
 * `ChatStreamCallbacks.onInteraction` re-implements: an id-keyed,
 * insertion-ordered list with
 *
 *   - forward-only status transitions (a replayed/stale `pending` never
 *     resurrects a resolved card),
 *   - pending-question content dedupe (a re-emitted duplicate ask never renders
 *     a second card),
 *   - cancel-event application (`interaction.cancel` → cancelled/expired),
 *   - local resolution marking (the card's `onResolved`),
 *   - reload restore from the answer route's GET list (sidecar registry is the
 *     source of truth after a reload),
 *   - turn-end settling (client mirror of the server's finalize pass: a turn
 *     that completed without a cancel was answered; a failed turn can make no
 *     such claim).
 *
 * The reducer functions are pure and exported for non-React consumers/tests;
 * the hook is a thin `useState` shell over them.
 */
import { type ChatInteraction, type ChatInteractionStatus, type InteractionAnswers, type InteractionCancelData, type InteractionRequestWire } from './chat-interactions';
/** Insert or update one interaction. A terminal existing entry wins over any
 *  incoming state for the same id; a new pending ask that duplicates another
 *  pending ask's content is dropped. Returns the same array when unchanged. */
export declare function upsertChatInteraction(list: ChatInteraction[], interaction: ChatInteraction): ChatInteraction[];
/** Applies an `interaction.cancel` event: only a pending ask moves, to
 *  `expired` (reason:"timeout") or `cancelled`. */
export declare function cancelChatInteraction(list: ChatInteraction[], cancel: InteractionCancelData): ChatInteraction[];
/** Marks one ask resolved locally (the card's `onResolved`). Forward-only. */
export declare function resolveChatInteraction(list: ChatInteraction[], id: string, status: Exclude<ChatInteractionStatus, 'pending'>, answers?: InteractionAnswers): ChatInteraction[];
/** Settles every still-pending ask when the turn ends: `answered` for a turn
 *  that completed cleanly, `expired` for one that failed. */
export declare function terminalizePendingChatInteractions(list: ChatInteraction[], status: Extract<ChatInteractionStatus, 'answered' | 'expired'>): ChatInteraction[];
/** Define modes for restoring chat interactions with legacy or durable strategies */
export type ChatInteractionRestoreMode = 'legacy' | 'durable';
/** Define options to control how chat interactions are restored during the restore process */
export interface RestoreChatInteractionsOptions {
    /**
     * `legacy` settles pending asks absent from the sidecar list as answered,
     * preserving the pre-durable restore contract. `durable` leaves them
     * pending because absence is ambiguous until `hydrateChatInteractions`
     * applies the durable projection.
     */
    mode?: ChatInteractionRestoreMode;
}
/** Reload restore from the answer route's GET list. Legacy consumers retain
 * the historical absence→answered behavior; durable consumers opt into the
 * ambiguity-preserving mode and apply terminal parts through `hydrate`. */
export declare function restoreChatInteractions(list: ChatInteraction[], outstanding: InteractionRequestWire[], options?: RestoreChatInteractionsOptions): ChatInteraction[];
/** Applies transcript/state-store projections after reload. Terminal state and
 * acknowledged answer values enrich an existing pending card without relying
 * on the sidecar's outstanding-list absence. */
export declare function hydrateChatInteractions(list: ChatInteraction[], persisted: ChatInteraction[]): ChatInteraction[];
/** Resolve and manage chat interactions with methods to update, cancel, mark resolved, and restore state */
export interface UseChatInteractionsResult {
    /** All known interactions, insertion-ordered. */
    interactions: ChatInteraction[];
    /** The asks currently blocking the run (waiting on the user). */
    pending: ChatInteraction[];
    /** Wire to `ChatStreamCallbacks.onInteraction` (and persisted-part replay). */
    upsert: (interaction: ChatInteraction) => void;
    /** Wire to `interaction.cancel` events. */
    applyCancel: (cancel: InteractionCancelData) => void;
    /** Wire to the cards' `onResolved`. */
    markResolved: (id: string, status: Exclude<ChatInteractionStatus, 'pending'>, answers?: InteractionAnswers) => void;
    /** Wire to the answer route's GET list after a reload/reconnect. */
    restore: (outstanding: InteractionRequestWire[], options?: RestoreChatInteractionsOptions) => void;
    /** Apply durable transcript/state projections after a reload. */
    hydrate: (persisted: ChatInteraction[]) => void;
    /** Settle still-pending asks when the turn ends. */
    terminalizePending: (status: Extract<ChatInteractionStatus, 'answered' | 'expired'>) => void;
    /** Drop everything (thread switch). */
    reset: () => void;
}
/** Resolve options for restoring chat interactions from previous sessions */
export type UseChatInteractionsOptions = RestoreChatInteractionsOptions;
/** Manage chat interactions state with upsert, cancel, resolve, and restore capabilities */
export declare function useChatInteractions(options?: UseChatInteractionsOptions): UseChatInteractionsResult;
