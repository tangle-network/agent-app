/**
 * Persistent assistant entry point: a floating launcher that opens the chat
 * panel as a right-side drawer (full-screen on small viewports), with focus
 * trapping and a resizable width. Owns the chat state (via useAssistantChat) so
 * the conversation survives the drawer closing — host-shell concerns (the user,
 * navigation, balance, money formatting, the graph renderer, and the workflow-
 * mutation signal) are injected.
 *
 * Mount inside an <AssistantClientProvider> (transport) and an
 * <AssistantLauncherProvider> (open/seed state).
 */
import { type ReactNode } from "react";
import { type ToolDetailRenderers } from "../web-react";
import { type AssistantPanelProps } from "./AssistantPanel";
import type { AssistantTranscriptView, ConfirmedResult, ConnectionRequirement, ConnectRequirementResult } from "./types";
export interface AssistantDockProps {
    /** The signed-in user this conversation belongs to (null when signed out). */
    userId: string | null;
    /** Host navigation for error CTAs and connect targets. */
    navigate?: (path: string) => void;
    balanceUsd?: number | null;
    formatMoney?: (usd: number | null) => string;
    /** Render workflow YAML as a node graph in a proposal card. */
    renderGraph?: (yaml: string) => ReactNode;
    /** Render the brand icon for a proposal requirement's integration provider.
     *  The host owns the provider→icon mapping (its integrations catalog); when
     *  absent, the card falls back to its built-in provider mark. */
    renderProviderIcon?: (provider: string) => ReactNode;
    /** Called after a workflow-mutating tool is confirmed (host re-fetches its list). */
    onWorkflowMutation?: () => void;
    /** In-place connect handler for a proposal's integration requirements. The host
     *  runs its own connect flow (OAuth popup, api-key modal, app install) and
     *  resolves whether the requirement is now satisfied; the proposal card then
     *  flips it to connected. Host-agnostic — when omitted, the card falls back to
     *  navigating the requirement's connect target via `navigate`. */
    onConnectRequirement?: (requirement: ConnectionRequirement) => Promise<ConnectRequirementResult>;
    /** Markdown renderer for assistant message content (plain text when absent). */
    renderMarkdown?: (content: string) => ReactNode;
    /** Per-tool custom detail renderers for expanded tool cards in the transcript. */
    toolRenderers?: ToolDetailRenderers;
    /** Render a prominent card for a CONFIRMED tool's result (e.g. a one-time
     *  API-key reveal for `create_api_key`), shown inline after the action's status
     *  line. The result's `output` may carry a one-time secret — see
     *  {@link ConfirmedResult} for the never-persist/never-to-model contract. */
    renderConfirmedResult?: (result: ConfirmedResult) => ReactNode;
    /** Swap the conversation rendering for a host-supplied renderer (see
     *  {@link AssistantPanelProps.renderTranscript}); the dock chrome, composer,
     *  transport, and proposal flow stay owned by the panel. */
    renderTranscript?: (view: AssistantTranscriptView) => ReactNode;
    /** Opt-in attachment surface for the dock's composer — forwarded to
     *  {@link AssistantPanelProps.composerAttachments}. */
    composerAttachments?: AssistantPanelProps["composerAttachments"];
    /** Forwarded to {@link AssistantPanelProps.onComposerSend}. */
    onComposerSend?: AssistantPanelProps["onComposerSend"];
}
export declare function AssistantDock({ userId, navigate, balanceUsd, formatMoney, renderGraph, renderProviderIcon, onWorkflowMutation, onConnectRequirement, renderMarkdown, toolRenderers, renderConfirmedResult, renderTranscript, composerAttachments, onComposerSend, }: AssistantDockProps): import("react").JSX.Element;
