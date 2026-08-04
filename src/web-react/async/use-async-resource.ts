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
 *   aborted and its late result is dropped by a monotonic sequence guard, so it
 *   cannot repaint a newer view.
 */
export function useAsyncResource<T>({
  load,
  deps = NO_DEPS,
  enabled = true,
  initialValue,
  isEmpty,
  errorMessage,
}: UseAsyncResourceOptions<T>): AsyncResourceState<T> {
  const loadRef = useRef(load)
  loadRef.current = load
  const isEmptyRef = useRef(isEmpty ?? defaultIsEmpty)
  isEmptyRef.current = isEmpty ?? defaultIsEmpty
  const errorMessageRef = useRef(errorMessage)
  errorMessageRef.current = errorMessage

  const [resolution, setResolution] = useState<AsyncResolution<T>>(() => {
    if (initialValue !== undefined) return resolveAsyncValue(initialValue, isEmpty ?? defaultIsEmpty)
    return enabled ? { status: 'loading' } : { status: 'idle' }
  })
  const [reloadKey, setReloadKey] = useState(0)

  const seqRef = useRef(0)
  // Consumed by the first load attempt: a seeded resource must not throw its
  // seed away to re-fetch what the server already sent.
  const seededRef = useRef(initialValue !== undefined)
  const token = useChangeToken(deps)

  useEffect(() => {
    if (!enabled) return
    if (seededRef.current) {
      seededRef.current = false
      return
    }

    const seq = ++seqRef.current
    const controller = new AbortController()
    setResolution({ status: 'loading' })

    void (async () => {
      try {
        const value = await loadRef.current({ signal: controller.signal })
        if (seq !== seqRef.current || controller.signal.aborted) return
        setResolution(resolveAsyncValue(value, isEmptyRef.current))
      } catch (error) {
        if (seq !== seqRef.current || controller.signal.aborted) return
        setResolution({
          status: 'error',
          message: errorMessageRef.current ? errorMessageRef.current(error) : asyncErrorMessage(error),
          error,
        })
      }
    })()

    return () => controller.abort()
  }, [token, enabled, reloadKey])

  const retry = useCallback(() => {
    setReloadKey((key) => key + 1)
  }, [])

  return useMemo<AsyncResourceState<T>>(() => {
    switch (resolution.status) {
      case 'ready':
        return { status: 'ready', value: resolution.value, retry }
      case 'empty':
        return { status: 'empty', value: resolution.value, retry }
      case 'error':
        return { status: 'error', message: resolution.message, error: resolution.error, retry }
      case 'loading':
        return { status: 'loading', retry }
      case 'idle':
        return { status: 'idle', retry }
    }
  }, [resolution, retry])
}
