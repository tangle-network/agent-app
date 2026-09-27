/**
 * Configurable network client for the assistant panel: the chat SSE stream, the
 * model/thread/history reads, and the proposal-confirmation call.
 *
 * The transport is injected via {@link AssistantClientConfig} so the same UI can
 * run in different hosts: a same-origin app authenticates with the session
 * cookie (`credentials: "include"`) and an `X-Requested-With` marker, while a
 * cross-origin host points `baseUrl` at the API and supplies a bearer token via
 * `headers`. The request shapes and the defensive wire parsing are identical
 * across hosts — only the base URL and the auth headers vary.
 */
import type { AssistantStreamEvent, ChatMessage, ChatRequest, PendingProposal } from "./types";
/** Host-supplied transport configuration for {@link createAssistantClient}. */
export interface AssistantClientConfig {
    /**
     * Base URL the five assistant endpoints hang off, with no trailing slash —
     * e.g. `"/api/v1/assistant"` for a same-origin SSR edge, or
     * `"https://id.tangle.tools/api/v1/assistant"` cross-origin. Each method
     * appends its own path (`/chat`, `/models`, `/threads`, …).
     */
    baseUrl: string;
    /**
     * `fetch` credentials mode. Defaults to `"include"` so a same-origin cookie
     * session authenticates; a token-based cross-origin host may pass `"omit"`
     * and carry the credential in {@link AssistantClientConfig.headers}.
     */
    credentials?: RequestCredentials;
    /**
     * Headers applied to every request — the auth token and/or the CSRF marker.
     * Called per request so a rotating token is read fresh, never captured once.
     */
    headers?: () => Record<string, string>;
}
/** Define options for an assistant model including identifier, label, pricing, and context tokens */
export interface AssistantModelOption {
    slug: string;
    label: string;
    /** USD per million prompt tokens, when the catalog carries pricing. */
    promptUsdPerMillion?: number;
    /** Context window in tokens, when known. */
    contextTokens?: number;
}
/** Define the structure for assistant model options including a default model slug and available models */
export interface AssistantModels {
    /** The slug the server uses when a turn selects no model. */
    default: string | null;
    models: AssistantModelOption[];
}
/** One past conversation in the history switcher. */
export interface AssistantThreadSummary {
    id: string;
    /** Truncated first user message; may be null for an untitled thread. */
    title: string | null;
    createdAt: string;
    updatedAt: string;
}
/**
 * Outcome of a model-list fetch. `ok` drives caching: the caller caches on `ok`
 * and retries on `!ok`. An EMPTY list is reported as `!ok` — the server always
 * offers at least the default model when the router is reachable, so an empty
 * menu means the catalog couldn't be loaded and should be retried, not cached
 * for the whole session.
 */
export interface AssistantModelsResult {
    ok: boolean;
    data: AssistantModels;
}
/**
 * Outcome of a thread-history restore. The three cases drive different recovery:
 * `ok` rehydrates the transcript; `gone` (the thread 404s — deleted or from a
 * reset DB) tells the caller to drop the dead thread id so the next turn starts
 * fresh; `error` (transient/network/aborted) keeps the thread id and simply
 * doesn't restore, so a later attempt or send still targets the live thread.
 */
export type ThreadHistoryResult = {
    status: "ok";
    messages: ChatMessage[];
    proposals: PendingProposal[];
} | {
    status: "gone";
} | {
    status: "error";
};
/** Represent the outcome of a confirmation process with success or failure details */
export type ConfirmResult = {
    ok: true;
    output: unknown;
    retryable?: boolean;
} | {
    ok: false;
    error: string;
};
/** Represent invalid client input errors with a specific code INVALID_REQUEST */
export declare class AssistantClientInputError extends Error {
    readonly code = "INVALID_REQUEST";
}
/** The assistant network surface, bound to one host's transport config. */
export interface AssistantClient {
    fetchModels(signal?: AbortSignal): Promise<AssistantModelsResult>;
    fetchThreads(signal?: AbortSignal): Promise<AssistantThreadSummary[] | null>;
    fetchThreadHistory(threadId: string, signal?: AbortSignal): Promise<ThreadHistoryResult>;
    streamChat(req: ChatRequest, onEvent: (event: AssistantStreamEvent) => void, signal: AbortSignal): Promise<void>;
    confirmProposal(proposalId: string): Promise<ConfirmResult>;
    /** Delete a thread and its server-side turns/proposals. Resolves `{ ok }`; a
     *  404 (already gone) is treated as success so a double-delete is harmless.
     *  Optional so a host with no delete endpoint stays a valid client — the panel
     *  hides the delete affordance when it's absent (see `useAssistantThreads`). */
    deleteThread?(threadId: string): Promise<{
        ok: boolean;
    }>;
}
/**
 * Build an assistant client bound to one host's transport. The returned methods
 * carry no module state, so a host may create one client per config (or share a
 * single same-origin client for the whole app).
 */
export declare function createAssistantClient(config: AssistantClientConfig): AssistantClient;
