/**
 * Pure view-model mappers for the assistant panel: how an error code becomes an
 * inline message + actionable next step, and how a proposed tool call becomes a
 * confirmation card. Kept free of React so the rendering decisions are unit
 * testable in isolation.
 */
import type { PendingProposal } from "./types";
interface ErrorCta {
    label: string;
    to: string;
}
interface ErrorView {
    message: string;
    cta: ErrorCta | null;
}
/**
 * Map a server error code + message to what the user sees and can do next.
 * Codes with a clear remedy carry a CTA; the rest fall back to the server's own
 * message, which is already written for the end user.
 */
export declare function presentError(code: string, message: string): ErrorView;
interface ProposalField {
    label: string;
    value: string;
}
/** A new skill minted alongside a workflow, shown as a named line on the card
 *  so the user sees what's being created without the raw skills JSON. */
interface ProposalSkill {
    name: string;
    description: string | null;
}
interface ProposalView {
    /** Verb-first heading, e.g. "Create workflow". */
    title: string;
    /** A body preview with its own label — a workflow's YAML (`kind: "workflow"`,
     *  rendered as a node graph with a YAML toggle) or a skill's instructions
     *  (`kind: "text"`, shown verbatim). Null when the action has no body. */
    preview: {
        label: string;
        content: string;
        kind: "workflow" | "text";
    } | null;
    /** Scalar arguments to show as a key/value list. */
    fields: ProposalField[];
    /** New skills minted alongside a workflow (author_workflow); omitted otherwise. */
    skills?: ProposalSkill[];
}
/**
 * Describe a proposed mutating action for its confirmation card. Workflow
 * create/update surface a YAML preview (the issue's required behavior); other
 * actions surface their scalar arguments. Unknown tools fall back to a generic
 * heading plus a JSON dump of the arguments so a newly added mutating tool is
 * never silently un-renderable.
 */
export declare function describeProposal(proposal: PendingProposal): ProposalView;
/**
 * Summarize a confirmed action's result for the transcript. Best-effort and
 * defensive: the output shape is the tool's return value, which varies by tool.
 */
export declare function describeOutcome(name: string, output: unknown): string;
/**
 * Summarize a confirmed action's FAILURE for the error banner. Mutating tools
 * report a domain failure by returning a negative outcome (see
 * `resolveConfirmation`); this turns that outcome into a human message,
 * preferring the server's own `errors[]`/`message` (already end-user-written)
 * and falling back to the not-found/conflict markers. Best-effort and
 * defensive: the shape varies by tool.
 */
export declare function describeFailure(output: unknown): string;
export declare function isLowBalance(balanceUsd: number | null): boolean;
/** The outcome of a confirmed tool call, mirroring `ConfirmResult` from the
 *  stream layer without coupling presentation to it. */
type ConfirmOutcome = {
    ok: true;
    output: unknown;
} | {
    ok: false;
    error: string;
};
interface ConfirmResolution {
    /** Transcript note to append, or null when there's nothing to say. */
    statusText: string | null;
    /** Error banner to surface, or null on a clean success. */
    error: {
        code: string;
        message: string;
    } | null;
}
/**
 * Decide what a confirmed proposal's result means for the transcript and the
 * error banner. The `invoke_integration` tool reports a not-connected provider
 * as a structured `{ ok: false, code: "NOT_CONNECTED" }` outcome inside `output`
 * (see the hub integration invoker); that exact signal maps to an
 * `INTEGRATION_DISCONNECTED` error so the panel can offer a "Connect" step.
 * Other failures surface as `TOOL_FAILED`. Pure so the classification is
 * unit-testable without the hook.
 */
export declare function resolveConfirmation(name: string, result: ConfirmOutcome): ConfirmResolution;
export {};
