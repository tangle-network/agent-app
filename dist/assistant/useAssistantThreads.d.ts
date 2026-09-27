/**
 * The user's recent assistant chat threads for the history switcher. Unlike the
 * model list (deployment config, fetched once), the thread list changes as the
 * user chats, so it is fetched ON DEMAND — call `refresh()` to (re)load it; the
 * panel does so when the history view opens and after a turn settles a new
 * thread into being. It does NOT fetch on mount, so `threads` stays empty and
 * `loaded` false until the first `refresh()`.
 *
 * Self-protective across account AND transport swaps. The list is tagged with the
 * (user, client) it belongs to and is masked to empty on the SAME commit if that
 * no longer matches the current props — so a swap never shows the prior scope's
 * threads for even one frame. In flight, a late result is dropped if either the
 * user or the client changed, and the request is aborted on the swap.
 *
 * A FAILED load is reported, not swallowed. `fetchThreads` answers a non-ok
 * response, an unusable body or a thrown request with `null`; that used to end
 * as `loaded: true` over an empty list, which renders identically to a user who
 * has never chatted. `error` carries the reason so the history view can offer
 * the retry instead — the `web-react/async` rule (a failed fetch cannot render
 * as empty data) applied to this hook's own transport.
 */
import type { AssistantThreadSummary } from "./client";
/** Manage and interact with a list of assistant threads including loading, refreshing, and removing threads */
export interface AssistantThreads {
    threads: AssistantThreadSummary[];
    loading: boolean;
    /** True once a fetch has settled at least once (drives empty-vs-loading copy). */
    loaded: boolean;
    /** Why the last load failed, or null. Non-null means the list on hand is stale
     *  or empty because the request FAILED — never because there is nothing to
     *  show. Cleared by the next successful load. */
    error: string | null;
    /** Load (or reload) the thread list. Must be called to populate `threads` —
     *  the hook never fetches on mount (the panel calls this when history opens). */
    refresh: () => void;
    /** Delete a thread. Optimistically drops it from the list (within the current
     *  owner scope); on failure the list is reloaded to restore the true state. A
     *  no-op resolving `{ ok: false }` when the client has no `deleteThread`. */
    remove: (threadId: string) => Promise<{
        ok: boolean;
    }>;
    /** Whether the configured client supports deletion — drives whether a host
     *  shows the delete affordance. */
    canRemove: boolean;
}
/** Resolve and manage assistant threads state for a given user including pending deletions and refresh logic */
export declare function useAssistantThreads(userId: string | null): AssistantThreads;
