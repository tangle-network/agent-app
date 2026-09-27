/**
 * Confirmation card for a mutating action the assistant proposed (create a
 * workflow, author a workflow + skills, run a workflow, manage a key, …). Shows
 * the action heading, its scalar fields, any new skills, a body preview (a
 * workflow renders as a node graph via the injected `renderGraph`, with a YAML
 * toggle; other bodies render verbatim), the integration requirements with a
 * connect affordance, and Confirm/Cancel.
 *
 * The body preview's graph is injected so this card — in the always-loaded
 * `./assistant` entry — doesn't pull the graph's `@xyflow/react` dependency; the
 * host wires `renderGraph` from `./workflows`. Navigation and the integration
 * provider icons (`renderProviderIcon`, from the host's integrations catalog)
 * are injected too.
 */
import { type ReactNode } from "react";
import type { ConnectionRequirement, PendingProposal } from "./types";
export interface ProposalCardProps {
    proposal: PendingProposal;
    /** True while this proposal's confirmation is in flight (disables the buttons). */
    confirming: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    /** Host navigation for connect targets / the integrations page. */
    navigate?: (path: string) => void;
    /** In-place connect handler for a requirement. When provided, a requirement's
     *  connect affordance calls this (showing a busy state) instead of navigating
     *  to `connectUrl`/the integrations page — the host runs its own connect flow
     *  and the card flips the requirement to connected on success. Host-agnostic;
     *  wired by the panel from {@link UseAssistantChatOptions.onConnectRequirement}. */
    onConnect?: (requirement: ConnectionRequirement) => void | Promise<void>;
    /** Render the workflow YAML as a node graph (the `./workflows` WorkflowGraph).
     *  When absent, the YAML is shown as text. */
    renderGraph?: (yaml: string) => ReactNode;
    /** Render the brand icon for an integration requirement's provider. The host
     *  owns the provider→icon mapping (its integrations catalog); when absent, or
     *  when it returns a nullish node for a provider it doesn't recognize, the row
     *  falls back to the shared sandbox-ui {@link ProviderIcon} mark (the same
     *  brand resolution the integrations catalog uses). */
    renderProviderIcon?: (provider: string) => ReactNode;
}
export declare function ProposalCard({ proposal, confirming, onConfirm, onCancel, navigate, onConnect, renderGraph, renderProviderIcon, }: ProposalCardProps): import("react").JSX.Element;
