import { type ReactNode } from 'react';
import type { ChatPlan } from '../plans/index';
import type { DurablePlanDecision, DurablePlanDecisionResult } from './durable-plan-flow';
export interface DurablePlanCardProps {
    plan: ChatPlan;
    canWrite: boolean;
    decide: (decision: DurablePlanDecision, feedback?: string) => Promise<DurablePlanDecisionResult | null>;
    deciding?: DurablePlanDecision | null;
    error?: string | null;
    renderMarkdown?: (markdown: string) => ReactNode;
    className?: string;
}
export declare function DurablePlanCard({ plan, canWrite, decide, deciding, error, renderMarkdown, className, }: DurablePlanCardProps): import("react").JSX.Element;
