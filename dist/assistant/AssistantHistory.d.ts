/**
 * The assistant's conversation history as a full-panel view: a searchable,
 * recency-sorted list of past threads, each showing its title and a relative
 * "last active" time, with inline delete. Replaces the cramped header dropdown —
 * inside an already-narrow side panel, a full-height list is far easier to scan
 * and navigate. Selection, deletion, and refresh are owned by the host panel;
 * this component is presentational and holds only its own search query.
 *
 * The four states the list can be in are rendered through `web-react/async`'s
 * `AsyncView` rather than a local ternary, because the ternary is what shipped
 * the defect: with no `error` branch, a failed thread fetch fell through to
 * "No past conversations yet." and told a user with a full history that they had
 * none, with no retry. `AsyncView` cannot render `error` as `empty` — they are
 * different variants — so the branch cannot go missing again. The load itself
 * stays in `useAssistantThreads` (whose owner-masking and pending-delete rules
 * are transport-specific); this component consumes its outcome.
 */
import type { AssistantThreadSummary } from "./client";
export interface AssistantHistoryProps {
    threads: AssistantThreadSummary[];
    /** True once a fetch has settled at least once (drives empty-vs-loading copy). */
    loaded: boolean;
    /** Why the load failed, from `useAssistantThreads`. Non-null renders the error
     *  branch with a retry instead of an empty list. REQUIRED: a caller that never
     *  has to answer "did the load fail?" is the caller that renders a failure as
     *  an empty list. */
    error: string | null;
    /** Re-runs the load — `useAssistantThreads().refresh`. Required so the error
     *  branch's button can never be inert. */
    onRetry: () => void;
    /** The thread the live conversation is on, highlighted in the list. */
    activeThreadId: string | null;
    /** Whether the active thread is mid-turn — its delete is disabled (the stream
     *  is still writing to it). */
    activeBusy: boolean;
    /** Whether the transport supports deletion (drives the delete affordance). */
    canRemove: boolean;
    onSelect: (threadId: string) => void;
    onDelete: (threadId: string) => void;
}
export declare function AssistantHistory({ threads, loaded, error, onRetry, activeThreadId, activeBusy, canRemove, onSelect, onDelete, }: AssistantHistoryProps): import("react").JSX.Element;
