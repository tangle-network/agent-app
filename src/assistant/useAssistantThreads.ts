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
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantClient, AssistantThreadSummary } from "./client";
import { useAssistantClient } from "./client-context";

export interface AssistantThreads {
  threads: AssistantThreadSummary[];
  loading: boolean;
  /** True once a fetch has settled at least once (drives empty-vs-loading copy). */
  loaded: boolean;
  /** Load (or reload) the thread list. Must be called to populate `threads` —
   *  the hook never fetches on mount (the panel calls this when history opens). */
  refresh: () => void;
  /** Delete a thread. Optimistically drops it from the list (within the current
   *  owner scope); on failure the list is reloaded to restore the true state. A
   *  no-op resolving `{ ok: false }` when the client has no `deleteThread`. */
  remove: (threadId: string) => Promise<{ ok: boolean }>;
  /** Whether the configured client supports deletion — drives whether a host
   *  shows the delete affordance. */
  canRemove: boolean;
}

interface ThreadsState {
  threads: AssistantThreadSummary[];
  loading: boolean;
  loaded: boolean;
  /** The (user, client) the data belongs to; the hook masks to empty unless both
   *  match the current props, so a swap can't show the prior scope's list. */
  ownerUserId: string | null;
  ownerClient: AssistantClient | null;
}

export function useAssistantThreads(userId: string | null): AssistantThreads {
  const client = useAssistantClient();
  const userRef = useRef(userId);
  userRef.current = userId;
  const clientRef = useRef(client);
  clientRef.current = client;
  const abortRef = useRef<AbortController | null>(null);
  // Ids being (or already) deleted. A refresh whose fetch began before the
  // server delete completed can return a row we optimistically removed; filter
  // these out of every refresh commit so a deleted thread never reappears.
  const pendingDeletesRef = useRef<Set<string>>(new Set());

  const [state, setState] = useState<ThreadsState>(() => ({
    threads: [],
    loading: false,
    loaded: false,
    ownerUserId: userId,
    ownerClient: client,
  }));

  const refresh = useCallback(() => {
    // Capture the user AND client this fetch is FOR; the commit and the owner tag
    // both use them, so a result can never land under a different scope.
    const requestedUserId = userRef.current;
    const requestedClient = clientRef.current;
    if (!requestedUserId) {
      setState({
        threads: [],
        loading: false,
        loaded: true,
        ownerUserId: requestedUserId,
        ownerClient: requestedClient,
      });
      return;
    }
    // Supersede any in-flight fetch so a rapid re-open can't land a stale list.
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setState((s) => ({
      ...s,
      loading: true,
      ownerUserId: requestedUserId,
      ownerClient: requestedClient,
    }));
    const isCurrent = () =>
      !ac.signal.aborted &&
      userRef.current === requestedUserId &&
      clientRef.current === requestedClient;
    void requestedClient
      .fetchThreads(ac.signal)
      .then((result) => {
        if (!isCurrent()) return;
        setState((s) => ({
          // null = transient failure: keep the prior list, just drop the spinner.
          // Drop any in-flight/finished deletions so a stale fetch can't resurrect
          // a row we already removed.
          threads: (result ?? s.threads).filter(
            (t) => !pendingDeletesRef.current.has(t.id),
          ),
          loading: false,
          loaded: true,
          ownerUserId: requestedUserId,
          ownerClient: requestedClient,
        }));
      })
      .catch(() => {
        // fetchThreads returns null rather than rejecting; this guards a future
        // change (or a throw in a state setter) from wedging the spinner.
        if (isCurrent()) {
          setState((s) => ({ ...s, loading: false, loaded: true }));
        }
      });
  }, []);

  const remove = useCallback(
    async (threadId: string) => {
      const requestedClient = clientRef.current;
      const requestedUserId = userRef.current;
      // A client without delete support can't remove anything — no-op rather
      // than optimistically drop a row that will never be deleted server-side.
      if (!requestedClient.deleteThread) return { ok: false };
      // Mark it deleting so a concurrent refresh's commit filters it out, then
      // optimistically drop the row — but only within the scope we're deleting
      // under (never mutate a swapped-in scope's list).
      pendingDeletesRef.current.add(threadId);
      setState((s) =>
        s.ownerClient === requestedClient && s.ownerUserId === requestedUserId
          ? { ...s, threads: s.threads.filter((t) => t.id !== threadId) }
          : s,
      );
      // Normalize a rejecting client to `{ ok: false }` so the rollback below
      // always runs (the bundled client resolves, but the interface allows any).
      let res: { ok: boolean };
      try {
        res = await requestedClient.deleteThread(threadId);
      } catch {
        res = { ok: false };
      }
      // On failure, un-mark it and reload to restore the row we optimistically
      // removed (only if we're still in the same scope). On success it stays
      // marked — the thread is gone for good and must never resurface.
      if (!res.ok) {
        pendingDeletesRef.current.delete(threadId);
        if (
          userRef.current === requestedUserId &&
          clientRef.current === requestedClient
        ) {
          refresh();
        }
      }
      return res;
    },
    [refresh],
  );

  // Abort an in-flight fetch on a scope swap (its result is already masked and
  // the commit guard rejects it; this just frees the network promptly) and on
  // unmount, so a late `.then` can't act after the panel closed.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, [userId, client]);

  // Drop the pending-delete ids only on true unmount — NOT on a scope swap. A
  // remove() awaiting its DELETE can outlive a swap-and-return to the same
  // scope; clearing on the swap would un-filter that id and let a stale refresh
  // resurrect the row. Thread ids are server-minted and globally unique, so the
  // set never false-filters another scope's list, and within one mount it only
  // grows by the user's own deletions (released here on unmount).
  useEffect(() => {
    return () => pendingDeletesRef.current.clear();
  }, []);

  // Mask synchronously: a list owned by a different (user, client) than the
  // current props is hidden on the same commit — no one-frame cross-scope leak.
  const stale = state.ownerUserId !== userId || state.ownerClient !== client;
  return {
    threads: stale ? [] : state.threads,
    loading: stale ? false : state.loading,
    loaded: stale ? false : state.loaded,
    refresh,
    remove,
    canRemove: typeof client.deleteThread === "function",
  };
}
