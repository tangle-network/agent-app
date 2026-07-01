/**
 * The assistant chat panel, built on web-react's chat components. The reducer
 * state is rendered by `AssistantTranscript` (web-react `ChatMessages`: transcript,
 * tool chips, reasoning preview, cost, proposal cards) and the composer is a
 * `ChatComposer` carrying the `ModelPicker` in its controls slot. The header's
 * history toggle swaps the conversation area for a full-panel, searchable history
 * view. App-shell concerns — the signed-in user, navigation, the credit balance,
 * money formatting, the markdown + tool-detail renderers, and the workflow-graph
 * renderer — are injected so the panel is portable across hosts. Chat state is
 * owned by the dock and passed in, so the conversation survives the drawer closing.
 */

import { History, MessageSquarePlus, Minus, Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogModel } from "../runtime/model-catalog";
import { ChatComposer, ModelPicker, type ToolDetailRenderers } from "../web-react";
import { AssistantHistory } from "./AssistantHistory";
import type { AssistantModels } from "./client";
import { isLowBalance, presentError } from "./presentation";
import { ProposalCard } from "./ProposalCard";
import { AssistantTranscript, assistantIsThinking } from "./transcript";
import type { AssistantTranscriptView } from "./types";
import type { AssistantChat } from "./useAssistantChat";
import { useAssistantModels } from "./useAssistantModels";
import { useAssistantThreads } from "./useAssistantThreads";
import { useFontScale } from "./usePanelPrefs";
import { useStickToBottom } from "./use-stick-to-bottom";

export interface AssistantPanelProps {
  chat: AssistantChat;
  userId: string | null;
  onClose: () => void;
  /** Host navigation for error CTAs and connect targets. */
  navigate?: (path: string) => void;
  /** The user's credit balance, for the header tile + low-balance nudge. */
  balanceUsd?: number | null;
  /** Format a USD amount; defaults to Intl currency formatting. */
  formatMoney?: (usd: number | null) => string;
  /** Render workflow YAML as a node graph in a proposal card (the `./workflows`
   *  WorkflowGraph). When absent, proposals show YAML as text. */
  renderGraph?: (yaml: string) => ReactNode;
  /** Markdown renderer for assistant message content. When absent, content
   *  renders as plain pre-wrapped text. */
  renderMarkdown?: (content: string) => ReactNode;
  /** Per-tool custom detail renderers for expanded tool cards in the transcript. */
  toolRenderers?: ToolDetailRenderers;
  /** Swap ONLY the conversation rendering for a host-supplied renderer (e.g. a
   *  different chat-message component), while the panel keeps owning the header,
   *  composer, model picker, history, transport, and proposal orchestration.
   *  Receives the transcript slice plus a bound proposal card to place. When
   *  absent, the built-in transcript (web-react `ChatMessages`) renders the
   *  conversation. */
  renderTranscript?: (view: AssistantTranscriptView) => ReactNode;
}

const EMPTY_STATE =
  "Ask me to create a workflow, check your usage, or manage your API keys.";

function defaultFormatMoney(usd: number | null): string {
  if (usd == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(usd);
}

/**
 * Map the assistant catalog onto the shared ModelPicker's wire shape. The slug
 * is already a canonical, provider-prefixed id, so it doubles as the picker's
 * value.
 *
 * Both the server `default` and the currently-`selected` slug are guaranteed a
 * row even when the catalog omits them (each appended only when not already
 * listed, so no duplicate is produced). Keeping the active selection visible is
 * what lets the picker show exactly what the next turn will send without the
 * panel ever rewriting the user's choice to avoid an orphaned value — a stale
 * slug (e.g. a model retired between refetches, or one missing from a filtered
 * catalog) stays selectable until the user changes it or the server rejects it,
 * which is when `useAssistantChat` clears it.
 *
 * An absent context window is omitted rather than passed as `undefined`; pricing
 * is omitted entirely because the catalog carries only a prompt price, which the
 * picker's "prompt / completion" line would misreport as a free completion.
 */
/** The provider segment of a canonical, provider-prefixed slug
 *  ("anthropic/claude-…" → "anthropic"); "other" when the slug isn't prefixed.
 *  Drives the picker's provider grouping + logo. */
function providerOf(slug: string): string {
  const i = slug.indexOf("/");
  return i > 0 ? slug.slice(0, i) : "other";
}

export function toPickerModels(
  models: AssistantModels,
  selected: string | null,
): CatalogModel[] {
  const row = (slug: string, label?: string, contextTokens?: number): CatalogModel => ({
    id: slug,
    name: label ?? slug,
    provider: providerOf(slug),
    supportsTools: true,
    supportsReasoning: false,
    featured: false,
    ...(contextTokens != null ? { contextLength: contextTokens } : {}),
  });
  const mapped: CatalogModel[] = models.models.map((m) =>
    row(m.slug, m.label, m.contextTokens),
  );
  for (const slug of [models.default, selected]) {
    if (slug && !mapped.some((m) => m.id === slug)) mapped.push(row(slug));
  }
  return mapped;
}

/** Small animated "working" cue shown above the composer while a turn streams —
 *  a redundant, renderer-independent signal alongside the composer's Stop button
 *  and the transcript's own thinking row. */
function WorkingIndicator() {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
      Working…
    </span>
  );
}

/**
 * The chat-state value to store for a model id chosen in the picker. Picking the
 * server default clears the preference to `null` — preserving the native-select
 * contract where "default" means "omit the model and follow whatever the server
 * default is", rather than pinning the default's slug (which would freeze the
 * user to it even after the server default changes). Any other id is stored as-is.
 */
export function nextModelSelection(
  id: string,
  defaultSlug: string | null,
): string | null {
  if (defaultSlug != null && id === defaultSlug) return null;
  return id || null;
}

export function AssistantPanel({
  chat,
  userId,
  onClose,
  navigate,
  balanceUsd = null,
  formatMoney = defaultFormatMoney,
  renderGraph,
  renderMarkdown,
  toolRenderers,
  renderTranscript,
}: AssistantPanelProps) {
  const models = useAssistantModels();
  const threads = useAssistantThreads(userId);
  const font = useFontScale();
  // Which surface the conversation area shows: the live chat, or the full-panel
  // history list. The header's history button toggles between them.
  const [view, setView] = useState<"chat" | "history">("chat");
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  // The conversation/history scroll container, used to scope the history-view
  // Escape handler and to move focus into the history view when it opens.
  const logRef = useRef<HTMLDivElement | null>(null);

  const pickerModels = useMemo<CatalogModel[]>(
    () => toPickerModels(models, chat.selectedModel),
    [models, chat.selectedModel],
  );
  // `toPickerModels` guarantees both the selected slug and the default a row, so
  // this value always resolves to a real option — the displayed model is exactly
  // the slug the next turn will send, with no panel-side rewrite of the user's
  // choice. Falls through to the default, then empty, only when nothing is set.
  const pickerValue = chat.selectedModel ?? models.default ?? "";

  const { state } = chat;
  // Always-current chat handle, so an async delete can re-check the LIVE thread
  // + status after awaiting (the closure's `chat`/`state` are render-time stale).
  const chatRef = useRef(chat);
  chatRef.current = chat;

  // When the history view opens, move focus into its search box, so keyboard
  // users land ready to type and the scoped Escape handler below receives the
  // key event. Focusing the input is more reliable than focusing the
  // tabIndex=-1 container, which some browsers handle inconsistently; the
  // container is a fallback only if the input isn't present.
  useEffect(() => {
    if (view !== "history") return;
    const search = logRef.current?.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    (search ?? logRef.current)?.focus();
  }, [view]);

  // In the history view, Escape returns to the conversation (and refocuses the
  // toggle) rather than closing the whole assistant. Scoped to Escapes that
  // originate inside the history view or from the toggle, so it never swallows
  // an Escape meant for an open composer popover/menu; handled in the capture
  // phase with stopImmediatePropagation so it preempts the dock's own
  // Escape-to-close. In the chat view no handler is installed, so Escape falls
  // through to the dock's close as usual.
  useEffect(() => {
    if (view !== "history") return;
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as Node;
      if (
        !logRef.current?.contains(target) &&
        !historyButtonRef.current?.contains(target)
      ) {
        return;
      }
      e.stopImmediatePropagation();
      setView("chat");
      historyButtonRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDownCapture, true);
    return () => document.removeEventListener("keydown", onKeyDownCapture, true);
  }, [view]);

  // Auto-follow: pin the transcript to the newest content as it streams, yielding
  // when the user scrolls up. `streamedLength` grows on every streamed token (each
  // delta extends the last message's text); combined with the message count and
  // status it drives the re-scroll signal. See `useStickToBottom`.
  const streamedLength = useMemo(
    () =>
      state.messages.reduce((total, m) => total + m.text.length, 0) +
      (state.reasoning?.length ?? 0),
    [state.messages, state.reasoning],
  );
  const { onScroll: handleConversationScroll } = useStickToBottom(logRef, {
    enabled: view === "chat",
    contentSignature: `${streamedLength}|${state.messages.length}|${state.status}`,
    streamingId: state.streamingId,
    threadId: state.threadId,
  });

  // Prefer the just-settled turn's balance (from the usage event, immediate)
  // over the injected fetched balance, which may lag a turn behind.
  const effectiveBalance = state.usage?.balanceUsd ?? balanceUsd;
  const errorView = state.error
    ? presentError(state.error.code, state.error.message)
    : null;
  const low = isLowBalance(effectiveBalance) && !errorView;
  const streaming = state.status === "streaming";
  // The active conversation's title — the first user message, truncated, mirroring
  // the server's own thread titling (a thread title IS its truncated first user
  // message). Derived client-side so it shows immediately on the first send and
  // on a restored thread, with no extra fetch. Null for a fresh, empty chat.
  const firstUserText = state.messages
    .find((m) => m.role === "user")
    ?.text.trim();
  // Truncate by code point (Array.from), not UTF-16 code unit, so a 60-char cut
  // can't split a surrogate pair (emoji / astral script) into a replacement char.
  const titleChars = firstUserText ? Array.from(firstUserText) : [];
  const conversationTitle = firstUserText
    ? titleChars.length > 60
      ? `${titleChars.slice(0, 60).join("")}…`
      : firstUserText
    : null;

  const renderProposal = (proposal: (typeof state.pendingProposals)[number]) => (
    <ProposalCard
      proposal={proposal}
      confirming={
        proposal.proposalId ? chat.confirmingIds.has(proposal.proposalId) : false
      }
      onConfirm={() => chat.confirm(proposal)}
      onCancel={() => chat.cancel(proposal)}
      navigate={navigate}
      renderGraph={renderGraph}
    />
  );

  const isThinking = assistantIsThinking(state);

  // The transcript slice — fed to either a host-supplied renderer or the
  // built-in `AssistantTranscript` (web-react `ChatMessages`).
  const transcriptView: AssistantTranscriptView = {
    messages: state.messages,
    reasoning: state.reasoning,
    streamingId: state.streamingId,
    model: state.model,
    isStreaming: streaming,
    isThinking,
    pendingProposals: state.pendingProposals,
    usage: state.usage,
    renderProposal,
  };

  // Entering history loads (or reloads) the thread list — the hook never fetches
  // on mount, so this is what populates it.
  const showHistory = () => {
    threads.refresh();
    setView("history");
  };
  const toggleHistory = () => {
    if (view === "history") setView("chat");
    else showHistory();
  };

  // Delete a past conversation. Deleting the *active* thread is refused while it
  // is mid-turn (the stream is still writing to it). The list row drops
  // optimistically (in the hook), but the LIVE conversation is only reset once
  // the server confirms the delete — so a failed delete never strands the user
  // on a fresh thread while the server still has the conversation.
  const deleteThread = async (threadId: string) => {
    // Refuse deleting the active thread while it is mid-turn. Read LIVE status
    // through the ref (not the render-time `state`) so the guard is authoritative
    // regardless of when this closure was created or how long the confirm sat
    // open — never delete a thread the stream is still writing to.
    const pre = chatRef.current.state;
    if (pre.threadId === threadId && pre.status !== "idle") return;
    if (!window.confirm("Delete this conversation? This can't be undone.")) {
      return;
    }
    const res = await threads.remove(threadId);
    // Reset the live conversation only if the just-deleted thread is STILL the
    // active, idle one. Re-checked through the ref because the user may have
    // switched threads or started a turn while the delete was in flight —
    // resetting then would wipe a different or now-busy conversation.
    const live = chatRef.current.state;
    if (res.ok && live.threadId === threadId && live.status === "idle") {
      chatRef.current.reset();
    }
  };

  return (
    <div className="relative flex h-full flex-col bg-background">
      {/* Header: identity + active-conversation title, and the conversation-level
          actions (text size, history, new, close). */}
      <div className="border-border border-b">
        <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2.5">
          <div className="flex min-w-0 flex-col">
            <div className="flex items-baseline gap-2">
              <span className="font-medium text-foreground text-sm">
                Assistant
              </span>
              <span
                aria-label="Your credit balance"
                className="text-muted-foreground text-xs"
              >
                {formatMoney(effectiveBalance)}
              </span>
            </div>
            {conversationTitle && (
              <span
                className="truncate text-muted-foreground text-xs"
                title={conversationTitle}
              >
                {conversationTitle}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/* Text size — zooms the transcript. A panel-level control, so it
                lives in the header action row rather than over the composer. */}
            <div
              className="flex items-center overflow-hidden rounded-md border border-border"
              role="group"
              aria-label="Text size"
            >
              <button
                type="button"
                onClick={font.decrease}
                disabled={!font.canDecrease}
                aria-label="Decrease text size"
                className="px-1.5 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={font.increase}
                disabled={!font.canIncrease}
                aria-label="Increase text size"
                className="border-border border-l px-1.5 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            <button
              ref={historyButtonRef}
              type="button"
              onClick={toggleHistory}
              aria-label="Chat history"
              aria-pressed={view === "history"}
              className={`rounded-md p-1.5 transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                view === "history"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground"
              }`}
            >
              <History className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                chat.reset();
                setView("chat");
              }}
              aria-label="New chat"
              title="New chat"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MessageSquarePlus className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close assistant"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Conversation — the full-panel history view, the host-swappable
          renderer, or the built-in timeline. */}
      <div
        ref={logRef}
        tabIndex={-1}
        aria-label="Conversation"
        onScroll={handleConversationScroll}
        // role="log" + aria-live announce streaming transcript updates; applied
        // only in the chat view so the history view's search box and buttons are
        // not announced as live conversation activity.
        role={view === "chat" ? "log" : undefined}
        aria-live={view === "chat" ? "polite" : undefined}
        className="min-h-0 flex-1 overflow-y-auto focus:outline-none"
      >
        {view === "history" ? (
          <AssistantHistory
            threads={threads.threads}
            loaded={threads.loaded}
            activeThreadId={state.threadId}
            activeBusy={state.status !== "idle"}
            canRemove={threads.canRemove}
            onSelect={(id) => {
              chat.switchThread(id);
              setView("chat");
            }}
            onDelete={(id) => void deleteThread(id)}
          />
        ) : (
          // The text-size control zooms the transcript only — not the history
          // view's search box and buttons. `zoom` scales every descendant
          // uniformly regardless of which renderer draws the conversation; an
          // inline `font-size` would not (the transcript's text utilities set
          // absolute rem sizes), and `transform: scale` would break the scroll
          // container by keeping the original layout box.
          <div className="px-2 py-3" style={{ zoom: font.scale }}>
            {renderTranscript ? (
              renderTranscript(transcriptView)
            ) : (
              <AssistantTranscript
                view={transcriptView}
                renderMarkdown={renderMarkdown}
                toolRenderers={toolRenderers}
                emptyState={
                  <p className="px-4 py-8 text-center text-muted-foreground text-sm">
                    {EMPTY_STATE}
                  </p>
                }
              />
            )}
          </div>
        )}
      </div>

      {/* Error / low-balance banners */}
      {errorView && (
        <div
          role="alert"
          className="mx-4 mb-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
        >
          <p className="text-foreground">{errorView.message}</p>
          {errorView.cta && (
            <button
              type="button"
              onClick={() => navigate?.(errorView.cta?.to ?? "")}
              className="mt-1 text-primary text-xs"
            >
              {errorView.cta.label} →
            </button>
          )}
        </div>
      )}
      {low && (
        <div
          role="status"
          className="mx-4 mb-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
        >
          <p className="text-foreground">Your credit balance is running low.</p>
          <button
            type="button"
            onClick={() => navigate?.("/app/billing")}
            className="mt-1 text-primary text-xs"
          >
            Add credits →
          </button>
        </div>
      )}

      {/* Continue: a capped turn stopped mid-plan (the step-limit backstop). One
          click resumes it — the thread keeps the full context — instead of making
          the user type "continue". Shown only when idle in the chat view; a new
          turn (including this one) clears `capped`. */}
      {state.capped &&
        state.status === "idle" &&
        !chat.restoring &&
        view === "chat" && (
          <div
            role="status"
            className="mx-4 mb-2 flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
          >
            <p className="min-w-0 flex-1 text-foreground">
              Paused after a lot of steps.
            </p>
            <button
              type="button"
              onClick={() => {
                setView("chat");
                // Sends "continue" as an ordinary user message — the same words
                // the prior capped-turn copy told users to type. Resume needs no
                // special backend handling: the server replays the thread's full
                // history on every turn, so the model picks up the interrupted
                // work from context. (This is the automated form of that manual
                // instruction, not a new magic string the backend must decode.)
                chat.send("continue");
              }}
              className="shrink-0 rounded-lg bg-primary px-3 py-1.5 font-semibold text-primary-foreground text-xs transition hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Continue
            </button>
          </div>
        )}

      {/* Composer: the model picker sits directly above the input, so the model
          the next turn will use reads as part of the composer. */}
      <div className="border-border border-t p-2">
        {/* Running indicator: while a turn streams, the composer's Send becomes a
            Stop button — on its own an easy-to-miss signal. This animated row makes
            "the assistant is working" unmistakable regardless of the transcript
            renderer in use. */}
        {streaming && (
          <div className="px-2 pb-1.5" aria-label="Assistant is working">
            <WorkingIndicator />
          </div>
        )}
        <ChatComposer
          onSend={(message) => {
            setView("chat");
            chat.send(message);
          }}
          onCancel={chat.stop}
          isStreaming={streaming}
          disabled={chat.restoring || state.status === "awaiting_confirm"}
          placeholder="Message the assistant…"
          controls={
            pickerModels.length > 0 ? (
              <ModelPicker
                value={pickerValue}
                onChange={(id) =>
                  chat.setModel(nextModelSelection(id, models.default))
                }
                models={pickerModels}
              />
            ) : (
              <span className="px-1 text-muted-foreground text-xs">
                Default model
              </span>
            )
          }
        />
      </div>
    </div>
  );
}
