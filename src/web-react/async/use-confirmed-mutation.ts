import { useCallback, useMemo, useRef, useState } from 'react'

import { asyncErrorMessage, readOkJson, requireOk } from './state'
import type { AsyncLoadContext } from './use-async-resource'

/**
 * The brand that makes "Saved" unreachable without a confirmed write.
 *
 * A resolved promise is not a success: `fetch` resolves on a 404, and the
 * shipped defect this closes is a save button that rendered "Saved" because the
 * only thing awaited was that the request came back at all. The success variant
 * therefore carries a symbol no object literal can spell, so the only way into
 * `succeeded` is `confirmWrite` / `confirmResponse` / `confirmJson` — each of
 * which has already checked that the write landed.
 */
export const CONFIRMED_WRITE: unique symbol = Symbol('agent-app.confirmed-write')

export interface MutationConfirmed<T> {
  readonly succeeded: true
  readonly value: T
  readonly [CONFIRMED_WRITE]: true
}

export interface MutationRejected {
  readonly succeeded: false
  /** Safe to render: what the user is told the write did not do. */
  readonly message: string
  readonly error?: unknown
}

export type MutationOutcome<T> = MutationConfirmed<T> | MutationRejected

/** Confirms a write whose success is already established (an SDK call that
 *  throws on failure, a store returning its own typed outcome). The deliberate
 *  act is the point — this call is what an audit greps for. */
export function confirmWrite<T>(value: T): MutationConfirmed<T> {
  return { succeeded: true, value, [CONFIRMED_WRITE]: true }
}

/** A write that did not land. Constructible by hand: failing loud is never the
 *  direction that needs guarding. */
export function rejectWrite(message: string, error?: unknown): MutationRejected {
  return error === undefined ? { succeeded: false, message } : { succeeded: false, message, error }
}

/** Confirms only a 2xx response. A 404/500 becomes a rejection carrying the
 *  status — never a success, whatever the promise did. */
export async function confirmResponse(response: Response): Promise<MutationOutcome<Response>> {
  try {
    return confirmWrite(await requireOk(response))
  } catch (error) {
    return rejectWrite(asyncErrorMessage(error), error)
  }
}

/** `confirmResponse` + a JSON body. A non-ok status, an unreadable body and a
 *  throwing `parse` are all rejections. */
export async function confirmJson<T>(response: Response, parse: (data: unknown) => T): Promise<MutationOutcome<T>> {
  try {
    return confirmWrite(await readOkJson(response, parse))
  } catch (error) {
    return rejectWrite(asyncErrorMessage(error), error)
  }
}

/** True only for a value built by one of the confirm helpers. Takes `unknown`
 *  because an untyped consumer can return anything from `mutate`. */
export function isConfirmedWrite<T>(outcome: unknown): outcome is MutationConfirmed<T> {
  if (typeof outcome !== 'object' || outcome === null) return false
  return (outcome as { readonly [CONFIRMED_WRITE]?: unknown })[CONFIRMED_WRITE] === true
}

function asRejection(outcome: unknown): MutationRejected | null {
  if (typeof outcome !== 'object' || outcome === null) return null
  const candidate = outcome as { succeeded?: unknown; message?: unknown; error?: unknown }
  if (candidate.succeeded !== false) return null
  const message = typeof candidate.message === 'string' && candidate.message.trim() !== ''
    ? candidate.message
    : UNCONFIRMED_MESSAGE
  return rejectWrite(message, candidate.error)
}

export type MutationState<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'pending' }
  | { readonly status: 'succeeded'; readonly value: T }
  | { readonly status: 'failed'; readonly message: string; readonly error: unknown }

export interface UseConfirmedMutationOptions<TInput, TValue> {
  /**
   * Performs the write and returns a confirmation. Anything else — including a
   * hand-written `{ succeeded: true }` — is treated as a failed write, because
   * an unbranded object is exactly the shape produced by code that never
   * checked the response.
   *
   * The context signal aborts only when a later `run` supersedes this one. It is
   * NOT aborted on unmount: a write the user asked for must not be cancelled by
   * navigating away.
   */
  mutate: (input: TInput, context: AsyncLoadContext) => Promise<MutationOutcome<TValue>>
  /** Fires after the state reaches `succeeded` (latest run only). */
  onSucceeded?: (value: TValue) => void
  /** Fires after the state reaches `failed` (latest run only). */
  onFailed?: (message: string, error: unknown) => void
  /** Maps a thrown value to the message the `failed` state renders. */
  errorMessage?: (error: unknown) => string
}

export interface ConfirmedMutation<TInput, TValue> {
  readonly state: MutationState<TValue>
  /** Runs the write. Never rejects — the outcome is returned and mirrored into
   *  `state`. Concurrent runs are last-write-wins; disable the control while
   *  `state.status === 'pending'`. */
  readonly run: (input: TInput) => Promise<MutationOutcome<TValue>>
  /** Back to `idle` (dismisses a "Saved" or error affordance). */
  readonly reset: () => void
}

const UNCONFIRMED_MESSAGE = 'The write could not be confirmed.'

const UNCONFIRMED_CONTRACT =
  'mutate() resolved without a confirmation. Return confirmWrite(value), confirmResponse(response) or confirmJson(response, parse) so the success state proves the write landed.'

/**
 * `idle | pending | succeeded | failed` over a write that must confirm itself.
 *
 * `succeeded` is reachable only through a branded confirmation, so the audited
 * "Saved on a 404" bug cannot be written with this hook: the 404 path produces
 * `failed` carrying the status, and a `mutate` that forgot to check produces
 * `failed` carrying the contract violation rather than a success it never
 * earned.
 */
export function useConfirmedMutation<TInput, TValue>({
  mutate,
  onSucceeded,
  onFailed,
  errorMessage,
}: UseConfirmedMutationOptions<TInput, TValue>): ConfirmedMutation<TInput, TValue> {
  const mutateRef = useRef(mutate)
  mutateRef.current = mutate
  const onSucceededRef = useRef(onSucceeded)
  onSucceededRef.current = onSucceeded
  const onFailedRef = useRef(onFailed)
  onFailedRef.current = onFailed
  const errorMessageRef = useRef(errorMessage)
  errorMessageRef.current = errorMessage

  const [state, setState] = useState<MutationState<TValue>>({ status: 'idle' })
  const seqRef = useRef(0)
  const inFlightRef = useRef<AbortController | null>(null)

  const run = useCallback(async (input: TInput): Promise<MutationOutcome<TValue>> => {
    inFlightRef.current?.abort()
    const controller = new AbortController()
    inFlightRef.current = controller
    const seq = ++seqRef.current

    setState({ status: 'pending' })

    let outcome: MutationOutcome<TValue>
    try {
      const returned: unknown = await mutateRef.current(input, { signal: controller.signal })
      outcome = isConfirmedWrite<TValue>(returned)
        ? returned
        : asRejection(returned) ?? rejectWrite(UNCONFIRMED_MESSAGE, new Error(UNCONFIRMED_CONTRACT))
    } catch (error) {
      outcome = rejectWrite(errorMessageRef.current ? errorMessageRef.current(error) : asyncErrorMessage(error), error)
    }

    // A superseded run reports its own outcome to its own caller and never
    // repaints the state a newer run owns.
    if (seq !== seqRef.current) return outcome

    if (outcome.succeeded) {
      setState({ status: 'succeeded', value: outcome.value })
      onSucceededRef.current?.(outcome.value)
    } else {
      setState({ status: 'failed', message: outcome.message, error: outcome.error })
      onFailedRef.current?.(outcome.message, outcome.error)
    }
    return outcome
  }, [])

  const reset = useCallback(() => {
    seqRef.current += 1
    inFlightRef.current?.abort()
    inFlightRef.current = null
    setState({ status: 'idle' })
  }, [])

  return useMemo(() => ({ state, run, reset }), [state, run, reset])
}
