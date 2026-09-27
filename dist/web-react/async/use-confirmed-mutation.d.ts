import type { AsyncLoadContext } from './use-async-resource';
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
export declare const CONFIRMED_WRITE: unique symbol;
export interface MutationConfirmed<T> {
    readonly succeeded: true;
    readonly value: T;
    readonly [CONFIRMED_WRITE]: true;
}
export interface MutationRejected {
    readonly succeeded: false;
    /** Safe to render: what the user is told the write did not do. */
    readonly message: string;
    readonly error?: unknown;
}
export type MutationOutcome<T> = MutationConfirmed<T> | MutationRejected;
/** Confirms a write whose success is already established (an SDK call that
 *  throws on failure, a store returning its own typed outcome). The deliberate
 *  act is the point — this call is what an audit greps for. */
export declare function confirmWrite<T>(value: T): MutationConfirmed<T>;
/** A write that did not land. Constructible by hand: failing loud is never the
 *  direction that needs guarding. */
export declare function rejectWrite(message: string, error?: unknown): MutationRejected;
/** Confirms only a 2xx response. A 404/500 becomes a rejection carrying the
 *  status — never a success, whatever the promise did. */
export declare function confirmResponse(response: Response): Promise<MutationOutcome<Response>>;
/** `confirmResponse` + a JSON body. A non-ok status, an unreadable body and a
 *  throwing `parse` are all rejections. */
export declare function confirmJson<T>(response: Response, parse: (data: unknown) => T): Promise<MutationOutcome<T>>;
/** True only for a value built by one of the confirm helpers. Takes `unknown`
 *  because an untyped consumer can return anything from `mutate`. */
export declare function isConfirmedWrite<T>(outcome: unknown): outcome is MutationConfirmed<T>;
export type MutationState<T> = {
    readonly status: 'idle';
} | {
    readonly status: 'pending';
} | {
    readonly status: 'succeeded';
    readonly value: T;
} | {
    readonly status: 'failed';
    readonly message: string;
    readonly error: unknown;
};
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
    mutate: (input: TInput, context: AsyncLoadContext) => Promise<MutationOutcome<TValue>>;
    /** Fires after the state reaches `succeeded` (latest run only). */
    onSucceeded?: (value: TValue) => void;
    /** Fires after the state reaches `failed` (latest run only). */
    onFailed?: (message: string, error: unknown) => void;
    /** Maps a thrown value to the message the `failed` state renders. */
    errorMessage?: (error: unknown) => string;
}
export interface ConfirmedMutation<TInput, TValue> {
    readonly state: MutationState<TValue>;
    /** Runs the write. Never rejects — the outcome is returned and mirrored into
     *  `state`. Concurrent runs are last-write-wins; disable the control while
     *  `state.status === 'pending'`. */
    readonly run: (input: TInput) => Promise<MutationOutcome<TValue>>;
    /** Back to `idle` (dismisses a "Saved" or error affordance). */
    readonly reset: () => void;
}
/**
 * `idle | pending | succeeded | failed` over a write that must confirm itself.
 *
 * `succeeded` is reachable only through a branded confirmation, so the audited
 * "Saved on a 404" bug cannot be written with this hook: the 404 path produces
 * `failed` carrying the status, and a `mutate` that forgot to check produces
 * `failed` carrying the contract violation rather than a success it never
 * earned.
 */
export declare function useConfirmedMutation<TInput, TValue>({ mutate, onSucceeded, onFailed, errorMessage, }: UseConfirmedMutationOptions<TInput, TValue>): ConfirmedMutation<TInput, TValue>;
