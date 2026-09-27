import type { ChatPlan } from '../plans/index';
/** Represent durable plan decisions as either approved or rejected */
export type DurablePlanDecision = 'approved' | 'rejected';
/** Stable authority receipt for the follow-up turn dispatched by a plan
 * decision. Consumers must make `attachFollowUp` idempotent by `receiptId`;
 * reload and retry deliberately invoke it again. */
export interface DurablePlanFollowUpReceipt {
    receiptId: string;
    planId: string;
    revision: number;
    turnId: string;
    state: string;
}
/** Describe the result of a durable plan decision including plan details and pending statuses */
export interface DurablePlanDecisionResult {
    plan: ChatPlan;
    followUp?: DurablePlanFollowUpReceipt;
    idempotent: boolean;
    projectionPending?: boolean;
    effectPending?: boolean;
}
/** Define input parameters for making a durable plan decision including optional feedback */
export interface DurablePlanDecisionInput {
    planId: string;
    revision: number;
    decision: DurablePlanDecision;
    feedback?: string;
}
/** Define input parameters for retrieving the current durable plan including optional revision number */
export interface DurablePlanCurrentInput {
    planId: string;
    revision?: number;
}
/** Define methods to obtain and decide durable plan decisions asynchronously */
export interface DurablePlanDecisionClient {
    current: (input: DurablePlanCurrentInput) => Promise<DurablePlanDecisionResult>;
    decide: (input: DurablePlanDecisionInput) => Promise<DurablePlanDecisionResult>;
}
/** Represent errors from DurablePlanClient operations including status, code, and current plan details */
export declare class DurablePlanClientError extends Error {
    readonly status: number;
    readonly code?: string | undefined;
    readonly currentPlan?: ChatPlan | undefined;
    constructor(message: string, status: number, code?: string | undefined, currentPlan?: ChatPlan | undefined);
}
/** Define configuration options for creating a durable plan decision client */
export interface DurablePlanDecisionClientOptions {
    url: string | ((input: DurablePlanCurrentInput | DurablePlanDecisionInput) => string);
    body?: Record<string, unknown> | ((input: DurablePlanDecisionInput) => Record<string, unknown>);
    fetchImpl?: typeof fetch;
}
/** Browser client for the shared durable-plan route. The route URL and all
 * product routing fields are injected; workspace/session identity is still
 * resolved and authorized on the server. */
export declare function createDurablePlanDecisionClient(options: DurablePlanDecisionClientOptions): DurablePlanDecisionClient;
/** Define options to configure durable plan flow with plan, client, and optional callbacks */
export interface UseDurablePlanFlowOptions {
    plan: ChatPlan;
    client: DurablePlanDecisionClient;
    /** Must be idempotent by receipt.receiptId. */
    attachFollowUp?: (receipt: DurablePlanFollowUpReceipt) => Promise<void> | void;
    onUpdated?: (plan: ChatPlan) => void;
}
/** Define the result and actions for managing a durable plan flow including decisions, restoration, and error handling */
export interface UseDurablePlanFlowResult {
    plan: ChatPlan;
    deciding: DurablePlanDecision | null;
    restoring: boolean;
    error: string | null;
    decide: (decision: DurablePlanDecision, feedback?: string) => Promise<DurablePlanDecisionResult | null>;
    restore: () => Promise<DurablePlanDecisionResult | null>;
    clearError: () => void;
}
/** Shared plan decision controller. It coalesces only concurrent attachment
 * attempts; a later retry/restore calls the consumer's idempotent transport
 * again so a lost response cannot strand an already-dispatched follow-up. */
export declare function useDurablePlanFlow(options: UseDurablePlanFlowOptions): UseDurablePlanFlowResult;
