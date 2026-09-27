import type { ReactNode } from 'react';
import { type ChatInteraction, type InteractionAnswers } from './chat-interactions';
import { type ChatPlan } from '../plans/index';
import type { DurablePlanDecision, DurablePlanDecisionResult } from './durable-plan-flow';
import type { SubmitInteractionAnswer } from './interaction-card-support';
export type DurableChatCard = {
    kind: 'plan';
    key: string;
    plan: ChatPlan;
} | {
    kind: 'interaction';
    key: string;
    interaction: ChatInteraction;
};
/** Converts persisted/live parts to canonical cards. Legacy interaction-plan
 * cards are suppressed only when their raw part carries an explicit planId and
 * revision matching a durable plan. Identical markdown alone is never proof. */
export declare function durableChatCardsFromParts(parts: Array<Record<string, unknown>>): DurableChatCard[];
export interface DurableChatCardsProps {
    parts: Array<Record<string, unknown>>;
    canWrite: boolean;
    submitInteraction: SubmitInteractionAnswer;
    decidePlan: (plan: ChatPlan, decision: DurablePlanDecision, feedback?: string) => Promise<DurablePlanDecisionResult | null>;
    decidingPlan?: (plan: ChatPlan) => DurablePlanDecision | null;
    planError?: (plan: ChatPlan) => string | null;
    onInteractionResolved?: (id: string, status: Exclude<ChatInteraction['status'], 'pending'>, answers?: InteractionAnswers) => void;
    onLateAnswer?: (message: string) => boolean | void | Promise<boolean | void>;
    /** Fired when the user asks the agent to re-submit an expired/withdrawn
     *  plan card as a new chat turn; receives that card's interaction. Omit to
     *  hide the affordance entirely. */
    onReRequest?: (interaction: ChatInteraction) => boolean | void | Promise<boolean | void>;
    /** Overrides the default re-request button label. */
    reRequestLabel?: string;
    renderMarkdown?: (markdown: string) => ReactNode;
    className?: string;
}
/** Ready-to-embed canonical question/plan card lane for persisted assistant
 * parts. Apps inject transport and styling callbacks instead of rebuilding the
 * lifecycle/render switch. */
export declare function DurableChatCards({ parts, canWrite, submitInteraction, decidePlan, decidingPlan, planError, onInteractionResolved, onLateAnswer, onReRequest, reRequestLabel, renderMarkdown, className, }: DurableChatCardsProps): import("react").JSX.Element | null;
