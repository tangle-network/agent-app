import { type AsyncResourceState } from './state';
export interface AsyncLoadContext {
    /** Aborted when the inputs change, a retry supersedes this load, or the
     *  component unmounts. Forward it to `fetch` so a superseded request stops. */
    readonly signal: AbortSignal;
}
export interface UseAsyncResourceOptions<T> {
    /**
     * The one load. Reject (or throw) to reach the `error` branch — a non-ok
     * response must reject too, which is what `requireOk`/`readOkJson` are for.
     * Read from a ref internally, so an inline arrow does not re-trigger; `deps`
     * is what declares when the load must run again.
     */
    load: (context: AsyncLoadContext) => Promise<T>;
    /** Re-runs the load when any entry changes by `Object.is`, like `useEffect`. */
    deps?: readonly unknown[];
    /** `false` holds the resource at `idle` and runs nothing — for inputs that are
     *  not resolved yet. Flipping it to `true` starts the load. */
    enabled?: boolean;
    /** First-render seed (an SSR/loader page). The hook starts resolved and skips
     *  the first load. Read once — later identity changes are ignored, so a
     *  revalidating loader belongs in `deps`, not here. */
    initialValue?: T;
    /** Splits a successful load into `empty` vs `ready`. Default: `defaultIsEmpty`. */
    isEmpty?: (value: T) => boolean;
    /** Maps a thrown value to the message the `error` branch renders. */
    errorMessage?: (error: unknown) => string;
}
/**
 * The five-state fetch machine: `idle | loading | error | empty | ready`.
 *
 * What it guarantees, and what the hand-rolled versions it replaces did not:
 *
 * - a rejected load lands on `error` with a message and a `retry`, never on an
 *   empty list;
 * - `empty` is only reachable from a load that actually succeeded;
 * - a superseded load (inputs changed, retry pressed, component unmounted) is
 *   aborted and its late result is dropped by a monotonic sequence guard, so it
 *   cannot repaint a newer view.
 */
export declare function useAsyncResource<T>({ load, deps, enabled, initialValue, isEmpty, errorMessage, }: UseAsyncResourceOptions<T>): AsyncResourceState<T>;
