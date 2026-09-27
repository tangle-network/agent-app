/**
 * Durable-plan application-shell contract.
 *
 * The sandbox SDK owns the authoritative plan lifecycle and decision APIs.
 * This module only projects that substrate state into chat events and
 * persisted message parts that products can render and restore.
 */
export declare const PLAN_SUBMITTED_EVENT: 'plan.submitted';
/** Sandbox plan lifecycle. `preparing` is the transient submission state and
 * is retained in the projection even though the chat card normally starts at
 * `pending`. */
export type ChatPlanStatus = 'preparing' | 'pending' | 'approved' | 'rejected' | 'superseded' | 'withdrawn';
type ChatPlanBase = {
    /** The sandbox SDK calls this field `id`; the transcript projection names
     * it explicitly so it cannot collide with a message-part id. */
    planId: string;
    revision: number;
    title?: string;
    body: string;
    submittedAt: string;
    /** Provider/Sandbox metadata is deliberately opaque to this package. */
    metadata?: Record<string, unknown>;
    decidedBy?: string;
};
/** Browser/persisted projection of the sandbox SDK's durable-plan union. */
export type ChatPlan = ChatPlanBase & ({
    status: 'preparing';
} | {
    status: 'pending';
} | {
    status: 'approved';
    decidedAt: string;
} | {
    status: 'rejected';
    decidedAt: string;
    feedback: string;
} | {
    status: 'superseded';
    supersededAt: string;
    supersededByPlanId: string;
} | {
    status: 'withdrawn';
    withdrawnAt: string;
    withdrawnReason: string;
});
/** Canonical transcript part for one durable plan. */
export type ChatPlanPersistedPart = ChatPlan & {
    type: 'plan';
};
/** Resolve the result of parsing a plan submission into success with value or failure with error */
export type ParsePlanSubmittedResult = {
    succeeded: true;
    value: ChatPlan;
} | {
    succeeded: false;
    error: string;
};
/** Generate a unique key string for a given plan identifier */
export declare function planPartKey(planId: string): string;
/** Generate a unique key string for a plan based on its ID and revision number */
export declare function planRevisionKey(planId: string, revision: number): string;
/** Generate a unique follow-up turn ID based on the plan ID and its outcome */
export declare function planFollowUpTurnId(planId: string, outcome: 'approved' | 'rejected'): string;
/** Plan status is monotonic: only a pending plan can settle. */
export declare function canTransitionPlanStatus(from: ChatPlanStatus, to: ChatPlanStatus): boolean;
/** Resolve a ChatPlan into its persisted part representation for storage or transmission */
export declare function planToPersistedPart(plan: ChatPlan): ChatPlanPersistedPart;
/** Resolve a persisted part object into a ChatPlan or return null if the type is not 'plan */
export declare function persistedPartToPlan(part: Record<string, unknown>): ChatPlan | null;
/** Parses both direct sandbox events (`data.plan`) and session envelopes
 * (`properties.plan`). Session identity is carried by the surrounding stream
 * and is deliberately not required in the payload. */
export declare function parsePlanSubmittedEvent(event: unknown): ParsePlanSubmittedResult;
export {};
