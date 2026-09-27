import type { TurnDriveResult } from '@tangle-network/sandbox';
import type { Outcome } from '../sandbox/outcome';
/** The stable identity a Workflow reuses on every retry of one turn. */
export interface DetachedTurnWorkflowIdentity {
    /** Sandbox session resume key. */
    sessionId: string;
    /** Sandbox completed-turn idempotency key. */
    turnId: string;
}
/** The part of Cloudflare's Workflow event needed by the tick. */
export interface CloudflareWorkflowEventLike<TPayload> {
    payload: TPayload;
}
/** A duration accepted by Cloudflare Workflow `step.sleep`. */
export type CloudflareWorkflowSleepDuration = `${number} ${'second' | 'seconds' | 'minute' | 'minutes' | 'hour' | 'hours' | 'day' | 'days' | 'week' | 'weeks' | 'month' | 'months' | 'year' | 'years'}` | number;
/** The durable Workflow operations used by the tick. */
export interface CloudflareWorkflowStepLike {
    do<T>(name: string, callback: (context: unknown) => Promise<T>): Promise<T>;
    sleep(name: string, duration: CloudflareWorkflowSleepDuration): Promise<void>;
}
/** The states returned by the Sandbox `driveTurn` primitive. */
export type DetachedTurnDriveState = TurnDriveResult['state'];
/** The small state contract a durable tick needs. Product observers may carry
 * a richer terminal receipt than Sandbox's `TurnDriveResult`. */
export interface DetachedTurnDriveResultLike {
    state: DetachedTurnDriveState;
}
/** The terminal result passed to product settlement. */
export type DetachedTurnTerminalResult<TResult extends DetachedTurnDriveResultLike = TurnDriveResult> = Exclude<TResult, {
    state: 'running';
}>;
/** A drive call's retryable transport boundary. */
export type DetachedTurnDriveOutcome<TResult extends DetachedTurnDriveResultLike = TurnDriveResult> = Outcome<TResult>;
/** Options for one durable detached-turn Workflow run. */
export interface DetachedTurnWorkflowTickOptions<TPayload extends DetachedTurnWorkflowIdentity, TSettled, TResult extends DetachedTurnDriveResultLike = TurnDriveResult> {
    event: CloudflareWorkflowEventLike<TPayload>;
    step: CloudflareWorkflowStepLike;
    /** One SDK drive pass. Rejected results must not enter the Workflow cache. */
    drive: (payload: TPayload) => Promise<DetachedTurnDriveOutcome<TResult>>;
    /** Must be idempotent: the Worker can stop after the write but before commit. */
    settle: (payload: TPayload, result: DetachedTurnTerminalResult<TResult>) => Promise<TSettled>;
    pollDelay?: CloudflareWorkflowSleepDuration;
    stepName?: string;
}
/**
 * Drive a detached SDK turn with durable steps, not an HTTP waitUntil lifetime.
 * Stable step names let an evicted Workflow resume without repeating committed
 * passes. Validation belongs inside step.do so a transient malformed response
 * is retried rather than committed permanently as a poisoned checkpoint.
 */
export declare function runDetachedTurnWorkflowTick<TPayload extends DetachedTurnWorkflowIdentity, TSettled, TResult extends DetachedTurnDriveResultLike = TurnDriveResult>(options: DetachedTurnWorkflowTickOptions<TPayload, TSettled, TResult>): Promise<TSettled>;
