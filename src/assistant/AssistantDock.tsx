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

import { MessageSquare } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
} from "react";
import type { ToolDetailRenderers } from "../web-react";
import { AssistantPanel } from "./AssistantPanel";
import { useAssistantLauncher } from "./launcher";
import { ResizeHandle } from "./ResizeHandle";
import type {
  AssistantTranscriptView,
  ConnectionRequirement,
  ConnectRequirementResult,
} from "./types";
import { useAssistantChat } from "./useAssistantChat";
import { useIsDesktop, usePanelWidth } from "./usePanelPrefs";

export interface AssistantDockProps {
  /** The signed-in user this conversation belongs to (null when signed out). */
  userId: string | null;
  /** Host navigation for error CTAs and connect targets. */
  navigate?: (path: string) => void;
  balanceUsd?: number | null;
  formatMoney?: (usd: number | null) => string;
  /** Render workflow YAML as a node graph in a proposal card. */
  renderGraph?: (yaml: string) => ReactNode;
  /** Called after a workflow-mutating tool is confirmed (host re-fetches its list). */
  onWorkflowMutation?: () => void;
  /** In-place connect handler for a proposal's integration requirements. The host
   *  runs its own connect flow (OAuth popup, api-key modal, app install) and
   *  resolves whether the requirement is now satisfied; the proposal card then
   *  flips it to connected. Host-agnostic — when omitted, the card falls back to
   *  navigating the requirement's connect target via `navigate`. */
  onConnectRequirement?: (
    requirement: ConnectionRequirement,
  ) => Promise<ConnectRequirementResult>;
  /** Markdown renderer for assistant message content (plain text when absent). */
  renderMarkdown?: (content: string) => ReactNode;
  /** Per-tool custom detail renderers for expanded tool cards in the transcript. */
  toolRenderers?: ToolDetailRenderers;
  /** Swap the conversation rendering for a host-supplied renderer (see
   *  {@link AssistantPanelProps.renderTranscript}); the dock chrome, composer,
   *  transport, and proposal flow stay owned by the panel. */
  renderTranscript?: (view: AssistantTranscriptView) => ReactNode;
}

/** Visible, focusable descendants of a container, in tab order. Visibility is
 *  checked via getClientRects rather than offsetParent, which is null for
 *  position:fixed elements and would wrongly exclude them. */
function focusableWithin(container: HTMLElement): HTMLElement[] {
  const selector =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.getClientRects().length > 0,
  );
}

export function AssistantDock({
  userId,
  navigate,
  balanceUsd = null,
  formatMoney,
  renderGraph,
  onWorkflowMutation,
  onConnectRequirement,
  renderMarkdown,
  toolRenderers,
  renderTranscript,
}: AssistantDockProps) {
  const { open, openAssistant, closeAssistant } = useAssistantLauncher();
  const chat = useAssistantChat(userId, {
    onWorkflowMutation,
    onConnectRequirement,
  });

  const isDesktop = useIsDesktop();
  const { width, maxWidth, setWidth, previewWidth, nudgeWidth } =
    usePanelWidth();

  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAssistant();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, closeAssistant]);

  // Move focus into the dialog on open; restore it to the opener on close.
  useEffect(() => {
    if (open) {
      if (!wasOpenRef.current && !returnFocusRef.current) {
        returnFocusRef.current = document.activeElement as HTMLElement | null;
      }
      wasOpenRef.current = true;
      const el = dialogRef.current;
      if (el) (focusableWithin(el)[0] ?? el).focus();
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      const target = returnFocusRef.current?.isConnected
        ? returnFocusRef.current
        : launcherRef.current;
      target?.focus();
      returnFocusRef.current = null;
    }
  }, [open]);

  const openDialog = () => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    openAssistant();
  };

  if (!open) {
    return (
      <button
        ref={launcherRef}
        type="button"
        onClick={openDialog}
        aria-label="Open assistant"
        className="fixed right-4 bottom-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-colors hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <MessageSquare className="h-6 w-6" />
      </button>
    );
  }

  // Keep Tab focus within the dialog while it's open.
  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = focusableWithin(dialog);
    if (focusables.length === 0) {
      e.preventDefault();
      dialog.focus();
      return;
    }
    // Non-empty here (length === 0 returned above); the index access is safe.
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;
    const inside = active instanceof Node && dialog.contains(active);
    if (e.shiftKey) {
      if (!inside || active === first || active === dialog) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <div
        aria-hidden="true"
        className="fixed inset-0 z-40 bg-black/40"
        onClick={() => closeAssistant()}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-label="Assistant"
        aria-modal="true"
        tabIndex={-1}
        onKeyDown={trapTab}
        style={isDesktop ? { width: `${width}px` } : undefined}
        className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-border border-l shadow-xl focus:outline-none"
      >
        <AssistantPanel
          key={userId ?? "anon"}
          chat={chat}
          userId={userId}
          onClose={() => closeAssistant()}
          navigate={navigate}
          balanceUsd={balanceUsd}
          formatMoney={formatMoney}
          renderGraph={renderGraph}
          renderMarkdown={renderMarkdown}
          toolRenderers={toolRenderers}
          renderTranscript={renderTranscript}
        />
        {isDesktop && (
          <ResizeHandle
            width={width}
            maxWidth={maxWidth}
            onPreview={previewWidth}
            onCommit={setWidth}
            onNudge={nudgeWidth}
          />
        )}
      </div>
    </>
  );
}
