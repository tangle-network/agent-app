/**
 * InteractionPlanCard — the plan-approval round-trip card (kind:"plan",
 * claude-code plan mode). The plan itself arrives as markdown in
 * `interaction.body`; the answerSpec is producer-defined, so fields render
 * generically — a free-text field doubles as the rejection-feedback input.
 * Approve POSTs outcome:"accepted", Request changes POSTs outcome:"declined"
 * with any typed feedback.
 *
 * Markdown is injected (`renderMarkdown`, matching the rest of `web-react`);
 * without it the plan body falls back to pre-wrapped plain text. Pure data +
 * callbacks: no fetch inside the component.
 */
import { type ReactNode } from 'react';
import type { ChatInteraction, ChatInteractionStatus } from './chat-interactions';
import { type SubmitInteractionAnswer } from './interaction-card-support';
export interface InteractionPlanCardProps {
    interaction: ChatInteraction;
    /** Viewer-vs-editor gate: false renders everything read-only. */
    canWrite: boolean;
    /** POST one resolution to the product's answer route (see
     *  `createInteractionAnswerSubmitter`). */
    submitAnswer: SubmitInteractionAnswer;
    /** Fired when this card resolves locally (approved/rejected, or discovered
     *  expired via a 410) so the stream/route state stays in sync. */
    onResolved?: (id: string, status: Exclude<ChatInteractionStatus, 'pending'>) => void;
    /** Fired when the user asks the agent to re-submit an expired/withdrawn plan
     *  as a new chat turn. Receives the interaction so a callback shared across
     *  cards (e.g. via DurableChatCards) knows which plan fired. Return/resolve
     *  `false` (or throw) to report the send failed and keep the affordance
     *  retryable. Omit to hide it entirely. */
    onReRequest?: (interaction: ChatInteraction) => boolean | void | Promise<boolean | void>;
    /** Overrides the default re-request button label
     *  ("Ask agent to re-submit the plan" — gtm's exact current copy). */
    reRequestLabel?: string;
    /** Renders the plan body (markdown). Falls back to pre-wrapped plain text. */
    renderMarkdown?: (markdown: string) => ReactNode;
    className?: string;
}
export declare function InteractionPlanCard({ interaction, canWrite, submitAnswer, onResolved, onReRequest, reRequestLabel, renderMarkdown, className, }: InteractionPlanCardProps): import("react").JSX.Element;
