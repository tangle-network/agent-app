/**
 * The assistant's selectable models for the composer's picker. The list is
 * deployment config (not per-user), so it is fetched once per transport and
 * shared across panel mounts via a cache keyed by the `AssistantClient`.
 *
 * The cache has no TTL: it lives for the page session and is revalidated by a
 * page refresh — acceptable for deployment-config data that changes only on a
 * redeploy. An empty/failed fetch is NOT cached, so it retries on the next mount.
 *
 * Keyed by client so a host that swaps the transport (a tenant/origin/account
 * change) never serves the previous client's catalog or skips the fetch for the
 * new one. A WeakMap lets a discarded client's bucket be collected with it.
 *
 * Client-only by design (a `createRoot` SPA, no React SSR), so the cache lives
 * in one browser tab and is never shared across server requests. Under Strict
 * Mode's double-mount the two effect runs share the one in-flight fetch; the
 * first run's `active = false` makes its callback a no-op, the second commits —
 * dedup holds, no torn state.
 */

import { useEffect, useReducer } from "react";
import type {
  AssistantClient,
  AssistantModels,
  AssistantModelsResult,
} from "./client";
import { useAssistantClient } from "./client-context";

const EMPTY: AssistantModels = { default: null, models: [] };

interface ModelCache {
  cache: AssistantModels | null;
  inflight: Promise<AssistantModelsResult> | null;
}

const byClient = new WeakMap<AssistantClient, ModelCache>();

function cacheFor(client: AssistantClient): ModelCache {
  let entry = byClient.get(client);
  if (!entry) {
    entry = { cache: null, inflight: null };
    byClient.set(client, entry);
  }
  return entry;
}

export function useAssistantModels(): AssistantModels {
  const client = useAssistantClient();
  // The per-client cache is the source of truth; `bump` just forces a re-read
  // once an async fetch settles. Deriving the return value during render (below)
  // — rather than mirroring it into state via an effect — means a client swap
  // shows the new client's catalog (or empty) on the SAME commit, with no stale
  // frame from the previous client.
  const [, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const entry = cacheFor(client);
    if (entry.cache) return;
    let active = true;
    entry.inflight ??= client.fetchModels();
    void entry.inflight
      .then((result) => {
        // Cache a successful fetch (a well-formed, non-empty list) and release
        // the settled promise — the cache now guards re-fetch. A failed fetch OR
        // an empty list (reported as !ok — catalog unavailable) leaves the cache
        // unset so the next mount retries instead of serving an empty picker.
        if (result.ok) entry.cache = result.data;
        entry.inflight = null;
        if (active) bump();
      })
      .catch(() => {
        // fetchModels swallows its own errors, so this only fires if a future
        // change lets it reject — release the slot so the next mount retries.
        entry.inflight = null;
      });
    return () => {
      active = false;
    };
  }, [client]);

  // Always the CURRENT client's catalog — synchronously correct across a swap.
  return cacheFor(client).cache ?? EMPTY;
}
