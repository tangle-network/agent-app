/**
 * InteractionQuestionCard — the agent-ask card every sandbox-backed chat UI
 * forked (~1,000 lines each in gtm/legal/tax). Renders the answerSpec
 * verbatim: selects (radio/checkbox by `multi`, write-in row only when the
 * sidecar granted `allowCustom`), free text, and minimal number/boolean/secret
 * inputs for open kinds.
 *
 * Behavior lifted from the gtm-agent fork (the most fix-absorbed):
 *   - a terminal stream status always wins over local optimistic state,
 *   - a 410 from the answer route flips the card to the same dead state a
 *     cancel event produces (never a raw error),
 *   - expired/withdrawn asks stay answerable: the answer is delivered as a NEW
 *     chat turn via `onLateAnswer` (secret-bearing asks are blocked from that
 *     path),
 *   - one submit in flight at a time; a failed/timed-out submit stays
 *     retryable.
 *
 * Pure data + callbacks: no fetch inside the component. Products bind the wire
 * via `createInteractionAnswerSubmitter` (or any `SubmitInteractionAnswer`).
 */
import { type ReactNode } from 'react';
import type { ChatInteraction, ChatInteractionStatus, ChatSelectField } from './chat-interactions';
import { type SubmitInteractionAnswer } from './interaction-card-support';
export type InteractionBadgeVariant = 'outline' | 'default' | 'destructive';
export declare function InteractionBadge({ variant, children }: {
    variant: InteractionBadgeVariant;
    children: string;
}): import("react").JSX.Element;
export declare function InteractionActionButton({ variant, onClick, disabled, children, }: {
    variant?: 'primary' | 'outline';
    onClick: () => void;
    disabled?: boolean;
    children: string;
}): import("react").JSX.Element;
export interface QuestionOptionListProps {
    /** Radio/checkbox group name — unique per field so selection is isolated. */
    groupName: string;
    /** Stable prefix for per-option input ids (label htmlFor pairing). */
    idPrefix: string;
    options: ChatSelectField['options'];
    /** Checkbox (multi-select) vs radio (single). */
    multi: boolean;
    selectedValues: string[];
    disabled: boolean;
    onToggle: (value: string) => void;
    /** Terminal answered state: the selected rows highlight (primary edge, tint,
     *  trailing check) so the card shows WHAT was answered, not just that it was. */
    answered?: boolean;
}
/** The radio/checkbox option rows for a select field. Renders a fragment of
 *  option `<label>` rows so a card keeps its own wrapping layout and appends
 *  its own write-in input.
 *
 *  The rows arrive as a SEQUENCE (`.agent-arrive` + `--stagger-index`), which
 *  is the difference between reading a list and being shown one: the eye is
 *  told there are N choices and in what order before it has read any of them.
 *  The index is safe to take straight from the map because an option list does
 *  not re-sort under a mounted card — a different set of options is a
 *  different `key`, and a different ask resets the card wholesale. */
export declare function QuestionOptionList({ groupName, idPrefix, options, multi, selectedValues, disabled, onToggle, answered, }: QuestionOptionListProps): import("react").JSX.Element;
export interface InteractionQuestionCardProps {
    interaction: ChatInteraction;
    /** Viewer-vs-editor gate: false renders everything read-only. */
    canWrite: boolean;
    /** POST one resolution to the product's answer route (see
     *  `createInteractionAnswerSubmitter`). Never called for late answers. */
    submitAnswer: SubmitInteractionAnswer;
    /** Fired when this card resolves locally (answered, or discovered expired
     *  via a 410) so the stream/route state stays in sync. */
    onResolved?: (id: string, status: Exclude<ChatInteractionStatus, 'pending'>, answers?: ChatInteraction['answers']) => void;
    /** Delivers a late answer (the ask expired/was withdrawn) as a fresh chat
     *  turn. Return/resolve `false` when the send was rejected so the card stays
     *  retryable. Omit to hide the late-answer affordance entirely. */
    onLateAnswer?: (message: string) => boolean | void | Promise<boolean | void>;
    /** Overrides the kind badge ("Question"). */
    kindLabel?: string;
    /** What happens if nobody answers, rendered beside the submit action.
     *
     *  The caller owns both the clock and the copy: this card holds no timer, so a
     *  deadline that counts down re-renders on the caller's cadence rather than
     *  driving one of its own — and the consequence of silence ("the default is
     *  taken", "the run fails") is the host's policy to state, not this card's to
     *  infer. */
    timeoutNote?: ReactNode;
    /** Renders `body` as markdown. Omitted, `body` renders as plain text — so a
     *  host that passes authored markdown without this shows its syntax raw.
     *
     *  `body` ONLY. `title` and every `field.label` stay plain strings: a label is
     *  also the input's accessible name (`aria-label`), which has to be text, and
     *  rendering one as nodes would either break that or silently disagree with
     *  what a screen reader announces. Put prose in `body`.
     *
     *  `interaction.body` is untrusted: it arrives off the wire, written by an
     *  agent or whoever authored the ask. This card never injects HTML, but a
     *  renderer that does is an XSS sink — so return React elements, and sanitize
     *  (DOMPurify or equivalent) if you must produce HTML. */
    renderMarkdown?: (markdown: string) => ReactNode;
    className?: string;
}
export declare function InteractionQuestionCard({ interaction, canWrite, submitAnswer, onResolved, onLateAnswer, kindLabel, timeoutNote, renderMarkdown, className, }: InteractionQuestionCardProps): import("react").JSX.Element;
