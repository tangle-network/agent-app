/**
 * Durable terminal assembly for a native turn admitted by another request.
 * Product callbacks own domain effects and may use their own Workflow steps;
 * this helper never nests those callbacks inside `step.do`.
 */
import type { NativeCompletionObservation, NativeCompletionReceipt } from '../chat-routes/native-completion';
import { type CloudflareWorkflowEventLike, type CloudflareWorkflowSleepDuration, type CloudflareWorkflowStepLike, type DetachedTurnWorkflowIdentity } from './detached-turn-workflow';
/** Stable identity required to resume a registered native completion. */
export interface NativeCompletionWorkflowPayload extends DetachedTurnWorkflowIdentity {
    registeredAt: number;
}
export interface NativeCompletionWorkflowOptions<TPayload extends NativeCompletionWorkflowPayload, TMessageId> {
    event: CloudflareWorkflowEventLike<TPayload>;
    step: CloudflareWorkflowStepLike;
    /** Read-only exact observation. It must never dispatch, drive, or cancel. */
    observe(payload: TPayload): Promise<NativeCompletionObservation>;
    /**
     * Product-owned idempotent preparation, for example artifact promotion and
     * output classification. It runs outside an enclosing Workflow step so a
     * product may use its own named steps without nesting `step.do`.
     */
    prepare?(payload: TPayload, receipt: NativeCompletionReceipt): Promise<NativeCompletionReceipt>;
    /** Durable transcript write. A supplied message id updates the existing row. */
    persistTranscript(payload: TPayload, receipt: NativeCompletionReceipt, existingMessageId?: TMessageId): Promise<TMessageId>;
    /**
     * Product-owned idempotent settlement. A rejection leaves the lock held and
     * skips finalization, making the failed dependency observable and retryable.
     */
    settle(payload: TPayload, receipt: NativeCompletionReceipt, messageId: TMessageId): Promise<NativeCompletionReceipt | void>;
    /** Optional product buffer completion after successful settlement. */
    finalizeBuffer?(payload: TPayload, receipt: NativeCompletionReceipt, messageId: TMessageId): Promise<void>;
    /** Release the product lock only after every terminal effect completed. */
    releaseLock(payload: TPayload): Promise<void>;
    pollDelay?: CloudflareWorkflowSleepDuration;
    stepName?: string;
}
/**
 * Drive exact observation through durable retry steps, then run the terminal
 * sequence once. `prepare` and `settle` are deliberately outside `step.do` so
 * product callbacks can compose their own named Cloudflare Workflow steps.
 */
export declare function runNativeCompletionWorkflow<TPayload extends NativeCompletionWorkflowPayload, TMessageId>(options: NativeCompletionWorkflowOptions<TPayload, TMessageId>): Promise<NativeCompletionReceipt>;
