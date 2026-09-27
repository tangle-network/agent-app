/**
 * The fetch-state contract: a failed load cannot render as empty data.
 *
 * Three shapes produce that defect, and two audited verticals shipped dozens of
 * each: a `catch` handler that only clears a loading flag, an early return on a
 * non-ok response, and a bare `null` returned while loading. All three end with
 * the same pixels a successful-but-empty load produces — "No templates
 * available", an empty member list, a blank conversation — so the reader cannot
 * tell "we asked and there is nothing" from "we could not ask", and the retry
 * that would fix it is never offered.
 *
 * `AsyncResourceState` makes the two outcomes separate variants: `error` is the
 * only one carrying a message and it is never reachable with a value, `empty` is
 * the only one carrying a resolved-but-empty value and it never carries a
 * message. A component rendering one is structurally not rendering the other.
 *
 * This file is React-free so the state model, the emptiness rule and the
 * Response readers can be unit-tested and reused outside a component.
 */
/**
 * - `idle` — no load has been attempted (the hook is disabled, or its inputs
 *   are not resolved yet). Distinct from `loading`: nothing is in flight.
 * - `loading` — a load is in flight and no value is held.
 * - `error` — the load failed. Carries the message and never a value.
 * - `empty` — the load succeeded and the value is empty. Never carries a message.
 * - `ready` — the load succeeded and the value is non-empty.
 */
export type AsyncResourceStatus = 'idle' | 'loading' | 'error' | 'empty' | 'ready';
/** Re-runs the load. Present on every variant so the error branch can never be
 *  rendered without the action that recovers from it. */
export interface AsyncRetryable {
    readonly retry: () => void;
}
export type AsyncResourceState<T> = ({
    readonly status: 'idle';
} & AsyncRetryable) | ({
    readonly status: 'loading';
} & AsyncRetryable) | ({
    readonly status: 'error';
    readonly message: string;
    readonly error: unknown;
} & AsyncRetryable) | ({
    readonly status: 'empty';
    readonly value: T;
} & AsyncRetryable) | ({
    readonly status: 'ready';
    readonly value: T;
} & AsyncRetryable);
/** The state model without the retry action — what a reducer produces. */
export type AsyncResolution<T> = {
    readonly status: 'idle';
} | {
    readonly status: 'loading';
} | {
    readonly status: 'error';
    readonly message: string;
    readonly error: unknown;
} | {
    readonly status: 'empty';
    readonly value: T;
} | {
    readonly status: 'ready';
    readonly value: T;
};
export declare const DEFAULT_ASYNC_ERROR_MESSAGE = "Something went wrong. Please try again.";
/**
 * Default emptiness rule: `null`/`undefined`, an empty array, an empty `Map` or
 * `Set`. A string, a number and a plain object are `ready` — `''` and `{}` are
 * legitimate values for the resources that produce them, and guessing otherwise
 * would route a real answer into the empty branch. Pass `isEmpty` for a shape
 * this cannot see into (`{ items: [] }`, a paged envelope, a count).
 */
export declare function defaultIsEmpty(value: unknown): boolean;
/** Best available human-readable message for a thrown value. Never returns an
 *  empty string — a blank error block reads as a rendering bug. */
export declare function asyncErrorMessage(error: unknown, fallback?: string): string;
/** Classifies a successfully loaded value into `ready` or `empty`. */
export declare function resolveAsyncValue<T>(value: T, isEmpty?: (value: T) => boolean): AsyncResolution<T>;
/**
 * A non-ok HTTP response, as a throwable. `requireOk`/`readOkJson` raise this so
 * a non-ok response reaches the `error` branch instead of an early `return` that
 * leaves the caller rendering the empty branch.
 */
export declare class AsyncRequestError extends Error {
    readonly status: number;
    readonly statusText: string;
    readonly url: string;
    /** First 200 characters of the response body when it could be read, else `''`.
     *  Kept off `message` so a server's HTML error page never becomes UI copy. */
    readonly body: string;
    constructor(response: {
        status: number;
        statusText?: string;
        url?: string;
    }, body?: string);
}
/** Returns the response when ok; throws `AsyncRequestError` otherwise. Reads the
 *  body only on the failure path, so the caller keeps an unconsumed stream. */
export declare function requireOk(response: Response): Promise<Response>;
/**
 * `requireOk` + `response.json()`. Without `parse` the result is `unknown`, so a
 * caller narrows at the JSON boundary rather than inheriting an unchecked shape;
 * with `parse` the validator runs inside the load and a rejection lands in the
 * `error` branch.
 */
export declare function readOkJson(response: Response): Promise<unknown>;
export declare function readOkJson<T>(response: Response, parse: (data: unknown) => T): Promise<T>;
