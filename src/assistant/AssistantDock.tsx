/**
 * The assistant's place in the app shell: a right-side panel that mirrors the
 * left sidebar. A panel toggle opens and closes it (top right while closed,
 * the header's inner edge while open) and ⌘E / Ctrl+E does the same. On wide
 * viewports the panel docks beside the page: it is non-modal, resizable, and
 * the launcher's `inset` tells the shell how far to pad its page column so the
 * panel never covers page content. On narrower viewports it opens as a modal
 * sheet, full screen on phones. Width and open state persist per user.
 *
 * The dock owns the chat state (via useAssistantChat) so the conversation
 * survives the panel closing. Host-shell concerns (the user, navigation,
 * balance, money formatting, renderers, the page context, and the
 * workflow-mutation signal) are injected.
 *
 * Mount inside an <AssistantClientProvider> (transport) and an
 * <AssistantLauncherProvider> (panel state).
 */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
} from "react";
import type { ToolDetailRenderers } from "../web-react";
import { AssistantPanel, type AssistantPanelProps } from "./AssistantPanel";
import { useAssistantLauncher } from "./launcher";
import { ASSISTANT_PANEL_ID, AssistantPanelToggle } from "./panel-toggle";
import { ResizeHandle } from "./ResizeHandle";
import type {
  AssistantPageContext,
  ConfirmedResult,
  ConnectionRequirement,
  ConnectRequirementResult,
} from "./types";
import { useAssistantChat } from "./useAssistantChat";
import { useMediaQuery } from "./usePanelPrefs";

export interface AssistantDockProps {
  /** The signed-in user this conversation belongs to (null when signed out). */
  userId: string | null;
  /** The page the user has open. Shown in the panel header and sent with
   *  every turn. */
  context?: AssistantPageContext | null;
  /** Render the panel toggle at the viewport's top right while the panel is
   *  closed. Pass false when the host places `AssistantPanelToggle` in its own
   *  header. Hosts can tune the floating position with the
   *  `--assistant-toggle-top` and `--assistant-toggle-right` CSS variables,
   *  and lift it above a fixed top bar with `--assistant-toggle-z`. */
  floatingToggle?: boolean;
  /** Host navigation for error CTAs and connect targets. */
  navigate?: (path: string) => void;
  balanceUsd?: number | null;
  formatMoney?: (usd: number | null) => string;
  /** Render workflow YAML as a node graph in a proposal card. */
  renderGraph?: (yaml: string) => ReactNode;
  /** Render the brand icon for a proposal requirement's integration provider.
   *  When absent, the card falls back to its built-in provider mark. */
  renderProviderIcon?: (provider: string) => ReactNode;
  /** Called after a workflow-mutating tool is confirmed (host re-fetches its list). */
  onWorkflowMutation?: () => void;
  /** In-place connect handler for a proposal's integration requirements. The
   *  host runs its own connect flow and resolves whether the requirement is now
   *  satisfied. When omitted, the card navigates to the requirement's connect
   *  target via `navigate`. */
  onConnectRequirement?: (
    requirement: ConnectionRequirement,
  ) => Promise<ConnectRequirementResult>;
  /** Per-tool detail renderers for expanded tool rows. */
  toolRenderers?: ToolDetailRenderers;
  /** Render a prominent card for a CONFIRMED tool's result (e.g. a one-time
   *  API-key reveal for `create_api_key`). The result's `output` may carry a
   *  one-time secret — see {@link ConfirmedResult}. */
  renderConfirmedResult?: (result: ConfirmedResult) => ReactNode;
  /** Opt-in attachment surface for the composer — forwarded to
   *  {@link AssistantPanelProps.composerAttachments}. */
  composerAttachments?: AssistantPanelProps["composerAttachments"];
  /** Forwarded to {@link AssistantPanelProps.onComposerSend}. */
  onComposerSend?: AssistantPanelProps["onComposerSend"];
}

/** Visible, focusable descendants of a container, in tab order. Visibility is
 *  checked via getClientRects rather than offsetParent, which is null for
 *  position:fixed elements and would wrongly exclude them. */
function focusableWithin(container: HTMLElement): HTMLElement[] {
  const selector =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.getClientRects().length > 0,
  );
}

/** Where typing belongs to the field, not to the app's shortcuts. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/** The composer if present, otherwise the panel's first focusable control. */
function initialFocus(panel: HTMLElement): HTMLElement {
  return (
    panel.querySelector<HTMLElement>("textarea:not([disabled])") ??
    focusableWithin(panel)[0] ??
    panel
  );
}

export function AssistantDock({
  userId,
  context = null,
  floatingToggle = true,
  navigate,
  balanceUsd = null,
  formatMoney,
  renderGraph,
  renderProviderIcon,
  onWorkflowMutation,
  onConnectRequirement,
  toolRenderers,
  renderConfirmedResult,
  composerAttachments,
  onComposerSend,
}: AssistantDockProps) {
  const {
    open,
    closeAssistant,
    toggleAssistant,
    seed,
    clearSeed,
    layout,
    openedOnLoad,
    panel: { width, maxWidth, setWidth, previewWidth, nudgeWidth },
  } = useAssistantLauncher();
  // Below 40rem the sheet takes the whole screen.
  const wideSheet = useMediaQuery("(min-width: 40rem)", true);
  const chat = useAssistantChat(userId, {
    onWorkflowMutation,
    onConnectRequirement,
    context,
  });

  const panelRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const sheet = layout === "sheet";

  // ⌘E / Ctrl+E toggles the panel, as the shared workspace layout toggles its
  // right pane. Typing in a field is left alone.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "e" || isEditableTarget(e.target)) return;
      e.preventDefault();
      toggleAssistant();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleAssistant]);

  // Escape closes the sheet from anywhere, and the docked panel only when
  // focus is inside it. An open popover inside the panel (the model picker)
  // owns its own Escape: a `usePopover` trigger carries BOTH aria-haspopup and
  // aria-expanded, unlike the transcript's expandable rows.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const panel = panelRef.current;
      if (
        panel?.querySelector('[aria-haspopup="true"][aria-expanded="true"]')
      ) {
        return;
      }
      if (!sheet && !(e.target instanceof Node && panel?.contains(e.target))) {
        return;
      }
      closeAssistant();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, sheet, closeAssistant]);

  // Move focus into the panel when the user opens it, and back when it closes
  // with focus inside it. A panel restored open on page load leaves focus on
  // the page the user came to.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      wasOpenRef.current = true;
      if (openedOnLoad) return;
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      const panel = panelRef.current;
      if (panel) initialFocus(panel).focus();
    } else if (!open && wasOpenRef.current) {
      wasOpenRef.current = false;
      const back = returnFocusRef.current;
      returnFocusRef.current = null;
      // Closing unmounts the focused control, which drops focus to <body>.
      // Anywhere else, the user already moved on.
      const focusLost =
        document.activeElement === null ||
        document.activeElement === document.body;
      if (!focusLost) return;
      // The opener may have unmounted with the panel (the floating toggle);
      // its replacement is the toggle rendered for the closed state.
      (back?.isConnected ? back : toggleRef.current)?.focus();
    }
  }, [open, openedOnLoad]);

  if (!open) {
    return floatingToggle ? (
      <AssistantPanelToggle
        buttonRef={toggleRef}
        className="fixed"
        style={{
          top: "var(--assistant-toggle-top, 0.75rem)",
          right: "var(--assistant-toggle-right, 0.75rem)",
          zIndex: "var(--assistant-toggle-z, 30)",
        }}
      />
    ) : null;
  }

  // Keep Tab focus within the sheet while it's open. The docked panel is part
  // of the page, so Tab moves freely between them.
  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!sheet || e.key !== "Tab") return;
    const container = panelRef.current;
    if (!container) return;
    const focusables = focusableWithin(container);
    if (focusables.length === 0) {
      e.preventDefault();
      container.focus();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;
    const inside = active instanceof Node && container.contains(active);
    if (e.shiftKey) {
      if (!inside || active === first || active === container) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const panel = (
    <AssistantPanel
      key={userId ?? "anon"}
      chat={chat}
      userId={userId}
      onClose={closeAssistant}
      layout={layout}
      context={context}
      toggleRef={toggleRef}
      navigate={navigate}
      balanceUsd={balanceUsd}
      formatMoney={formatMoney}
      renderGraph={renderGraph}
      renderProviderIcon={renderProviderIcon}
      toolRenderers={toolRenderers}
      renderConfirmedResult={renderConfirmedResult}
      composerSeed={seed}
      onComposerSeedApplied={clearSeed}
      composerAttachments={composerAttachments}
      onComposerSend={onComposerSend}
    />
  );

  if (sheet) {
    return (
      <>
        <div
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-black/50"
          onClick={closeAssistant}
        />
        <div
          ref={panelRef}
          id={ASSISTANT_PANEL_ID}
          role="dialog"
          aria-label="Assistant"
          aria-modal="true"
          tabIndex={-1}
          onKeyDown={trapTab}
          // Full screen on phones; on tablets the user's width, capped by the
          // viewport.
          style={{ width: wideSheet ? `min(${width}px, 100vw)` : "100%" }}
          className="fixed inset-y-0 right-0 z-50 flex flex-col border-border border-l shadow-[var(--shadow-overlay)] focus:outline-none"
        >
          {panel}
        </div>
      </>
    );
  }

  return (
    <aside
      ref={panelRef}
      id={ASSISTANT_PANEL_ID}
      aria-label="Assistant"
      tabIndex={-1}
      style={{ width: `${width}px` }}
      className="fixed inset-y-0 right-0 z-30 flex flex-col border-border border-l focus:outline-none"
    >
      {panel}
      <ResizeHandle
        width={width}
        maxWidth={maxWidth}
        onPreview={previewWidth}
        onCommit={setWidth}
        onNudge={nudgeWidth}
      />
    </aside>
  );
}
