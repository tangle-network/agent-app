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
import type { AssistantModels } from "./client";
/** Resolve and return the current assistant models from the per-client cache with immediate client swap updates */
export declare function useAssistantModels(): AssistantModels;
