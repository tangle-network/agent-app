import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  asyncErrorMessage,
  defaultIsEmpty,
  resolveAsyncValue,
  type AsyncResolution,
  type AsyncResourceState,
} from './state'

export interface AsyncLoadContext {
  /** Aborted when the inputs change, a retry supersedes this load, or the
   *  component unmounts. Forward it to `fetch` so a superseded request stops. */
  readonly signal: AbortSignal
}

export interface UseAsyncResourceOptions<T> {
  /**
   * The one load. Reject (or throw) to reach the `error` branch — a non-ok
   * response must reject too, which is what `requireOk`/`readOkJson` are for.
   * Read from a ref internally, so an inline arrow does not re-trigger; `deps`
   * is what declares when the load must run again.
   */
  load: (context: AsyncLoadContext) => Promise<T>
  /** Re-runs the load when any entry changes by `Object.is`, like `useEffect`. */
  deps?: readonly unknown[]
  /** `false` holds the resource at `idle` and runs nothing — for inputs that are
   *  not resolved yet. Flipping it to `true` starts the load. */
  enabled?: boolean
  /** First-render seed (an SSR/loader page). The hook starts resolved and skips
   *  the first load. Read once — later identity changes are ignored, so a
   *  revalidating loader belongs in `deps`, not here. */
  initialValue?: T
  /** Splits a successful load into `empty` vs `ready`. Default: `defaultIsEmpty`. */
  isEmpty?: (value: T) => boolean
  /** Maps a thrown value to the message the `error` branch renders. */
  errorMessage?: (error: unknown) => string
}

/** Bumps a token when any dependency changes identity, so the effect's own
 *  dependency list stays a fixed length whatever the caller passes. */
function useChangeToken(deps: readonly unknown[]): number {
  const ref = useRef<{ deps: readonly unknown[]; token: number }>({ deps, token: 0 })
  const changed =
    ref.current.deps.length !== deps.length || deps.some((dep, index) => !Object.is(dep, ref.current.deps[index]))
  if (changed) ref.current = { deps, token: ref.current.token + 1 }
  return ref.current.token
}

const NO_DEPS: readonly unknown[] = []

/**
 * The five-state fetch machine: `idle | loading | error | empty | ready`.
 *
 * What it guarantees, and what the hand-rolled versions it replaces did not:
 *
 * - a rejected load lands on `error` with a message and a `retry`, never on an
 *   empty list;
 * - `empty` is only reachable from a load that actually succeeded;
 * - a superseded load (inputs changed, retry pressed, component unmounted) is
 *   aborted and its late result is discarded; resolutions are bound to their
 *   input identity, including the render before the next effect runs.
 */
export function useAsyncResource<T>({
  load,
  deps = NO_DEPS,
  enabled = true,
  initialValue,
  isEmpty,
  errorMessage,
}: UseAsyncResourceOptions<T>): AsyncResourceState<T> {
  // Include enablement and retries in the identity: stale data must not be
  // returned during the render before an effect clears the previous request.
  const [reloadKey, setReloadKey] = useState(0)
  const token = useChangeToken([enabled, reloadKey, ...deps])
  const options = useRef({ load, isEmpty, errorMessage })
  options.current = { load, isEmpty, errorMessage }
  const [settled, setSettled] = useState<{ token: number; resolution: AsyncResolution<T> }>(() => ({
    token,
    resolution: initialValue === undefined
      ? { status: 'loading' }
      : resolveAsyncValue(initialValue, isEmpty ?? defaultIsEmpty),
  }))
  // A seed belongs only to its first identity. Effect replay does not consume
  // it, but a dependency change, re-enable, or explicit retry does.
  const seededToken = useRef(initialValue === undefined ? null : token)

  useEffect(() => {
    if (!enabled || seededToken.current === token) return
    const controller = new AbortController()
    const commit = (resolution: AsyncResolution<T>) => {
      if (!controller.signal.aborted) setSettled({ token, resolution })
    }
    commit({ status: 'loading' })
    void (async () => {
      try {
        const value = await options.current.load({ signal: controller.signal })
        if (!controller.signal.aborted) commit(resolveAsyncValue(value, options.current.isEmpty ?? defaultIsEmpty))
      } catch (error) {
        if (!controller.signal.aborted) commit({
          status: 'error',
          message: options.current.errorMessage?.(error) ?? asyncErrorMessage(error),
          error,
        })
      }
    })()
    return () => controller.abort()
  }, [token, enabled])

  const retry = useCallback(() => setReloadKey(key => key + 1), [])
  return useMemo<AsyncResourceState<T>>(() => ({
    ...(!enabled ? { status: 'idle' as const }
      : settled.token === token ? settled.resolution : { status: 'loading' as const }),
    retry,
  }), [enabled, settled, token, retry])
}
