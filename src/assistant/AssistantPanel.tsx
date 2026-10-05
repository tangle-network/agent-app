/**
 * The assistant chat panel. The conversation renders through the main chat's
 * primitives (`AssistantTranscript` over `AgentTimeline`), notices follow the
 * main chat's status banners, and the composer is the same `ChatComposer` the
 * sandbox session uses, with the quiet `ModelPicker` in its controls slot. The
 * header names the page the assistant is looking at; its history toggle swaps
 * the conversation for a searchable history view. App-shell concerns (the
 * signed-in user, navigation, balance, money formatting, tool-detail and graph
 * renderers) are injected so the panel is portable across hosts. Chat state is
 * owned by the dock and passed in, so the conversation survives the panel
 * closing.
 */

import { focusRing } from "@tangle-network/ui/utils";
import {
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  History,
  Info,
  MessageSquarePlus,
  X,
} from "lucide-react";
import {
  type ReactNode,
  type Ref,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CatalogModel } from "../runtime/model-catalog";
import {
  ChatComposer,
  type ComposerFile,
  ModelPicker,
  type ToolDetailRenderers,
} from "../web-react";
import { AssistantHistory } from "./AssistantHistory";
import type { AssistantModels } from "./client";
import type { AssistantPanelLayout } from "./launcher";
import { AssistantPanelToggle } from "./panel-toggle";
import { isLowBalance, presentError } from "./presentation";
import { ProposalCard } from "./ProposalCard";
import { AssistantTranscript, assistantIsThinking } from "./transcript";
import type {
  AssistantPageContext,
  AssistantTranscriptView,
  ConfirmedResult,
} from "./types";
import type { AssistantChat } from "./useAssistantChat";
import { useAssistantModels } from "./useAssistantModels";
import { useAssistantThreads } from "./useAssistantThreads";
import { useStickToBottom } from "./use-stick-to-bottom";

export interface AssistantPanelProps {
  chat: AssistantChat;
  userId: string | null;
  onClose: () => void;
  /** `docked` puts the panel toggle on the header's inner edge; `sheet` adds a
   *  close button on its outer edge. Defaults to `docked`. */
  layout?: AssistantPanelLayout;
  /** The page the user has open, named under the panel title. */
  context?: AssistantPageContext | null;
  /** Receives the header's panel toggle, so the dock can return focus to it. */
  toggleRef?: Ref<HTMLButtonElement>;
  /** Host navigation for error CTAs and connect targets. */
  navigate?: (path: string) => void;
  /** The user's credit balance, for the header and the low-balance notice. */
  balanceUsd?: number | null;
  /** Format a USD amount; defaults to Intl currency formatting. */
  formatMoney?: (usd: number | null) => string;
  /** Render workflow YAML as a node graph in a proposal card. When absent,
   *  proposals show YAML as text. */
  renderGraph?: (yaml: string) => ReactNode;
  /** Render the brand icon for a proposal requirement's integration provider.
   *  When absent, the card falls back to its built-in provider mark. */
  renderProviderIcon?: (provider: string) => ReactNode;
  /** Per-tool detail renderers for expanded tool rows. A renderer returning
   *  null falls back to the shared row's input/output detail. */
  toolRenderers?: ToolDetailRenderers;
  /** Render a prominent card for a CONFIRMED tool's result (e.g. a one-time
   *  API-key reveal for `create_api_key`), shown after the action's status. */
  renderConfirmedResult?: (result: ConfirmedResult) => ReactNode;
  /** One-shot composer prefill from the host's launcher (e.g. a page's "Create
   *  with assistant" button passing `openAssistant(seed)`). The panel adopts it
   *  as the composer draft and calls `onComposerSeedApplied` once, so the host
   *  clears its seed state (consume-once). */
  composerSeed?: string | null;
  onComposerSeedApplied?: () => void;
  /** Opt-in attachment surface for the composer, mirroring `ChatComposer`'s
   *  attachment props: pass `onAttach` to show the attach button and accept
   *  drag-and-drop, and drive the staged-file chips with `pendingFiles` /
   *  `onRemoveFile` (web-react's `useComposerAttachments` owns that lifecycle).
   *  Omitted, the composer stays text-only. The assistant wire carries text
   *  only, so a host that stages files owns getting their content to the model
   *  (e.g. inlined on the next `chat.send`); `onComposerSend` is the signal to
   *  consume and clear the staged set. */
  composerAttachments?: {
    onAttach: (files: FileList) => void;
    onAttachFolder?: (files: FileList) => void;
    pendingFiles?: ComposerFile[];
    onRemoveFile?: (id: string) => void;
    accept?: string;
  };
  /** Fired when the composer sends (alongside `chat.send`) — the host's signal
   *  to consume and clear its staged attachments. */
  onComposerSend?: (message: string) => void;
}

/**
 * First-run starters. Each seeds the composer; nothing is sent until the user
 * sends the draft. With a page in context, the first starter asks about it.
 */
const STARTERS = [
  { label: "Create a workflow", seed: "Create a workflow that " },
  { label: "Check usage", seed: "What did my workflows cost this week?" },
  { label: "Manage API keys", seed: "Create an API key named " },
];
const PAGE_STARTER = {
  label: "Explain this page",
  seed: "Explain what this page shows and what I can do next.",
};

function defaultFormatMoney(usd: number | null): string {
  if (usd == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(usd);
}

/** Header actions share the panel toggle's geometry: 32px target, 18px glyph. */
const HEADER_BUTTON = `flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--accent-surface-soft)] hover:text-foreground ${focusRing}`;

type NoticeTone = "error" | "warning" | "info";

const NOTICE_TONE: Record<
  NoticeTone,
  { surface: string; icon: string; Glyph: typeof AlertCircle }
> = {
  error: {
    surface:
      "border-[var(--surface-danger-border)] bg-[var(--surface-danger-bg)]",
    icon: "text-[var(--surface-danger-text)]",
    Glyph: AlertCircle,
  },
  warning: {
    surface:
      "border-[var(--surface-warning-border)] bg-[var(--surface-warning-bg)]",
    icon: "text-[var(--surface-warning-text)]",
    Glyph: AlertTriangle,
  },
  info: {
    surface: "border-border bg-background",
    icon: "text-muted-foreground",
    Glyph: Info,
  },
};

/**
 * A notice beside the composer, in the main chat's status-banner layout and
 * semantic surface tokens. The live region wraps only the text, so the action
 * button keeps its button semantics.
 */
function Notice({
  tone,
  children,
  action,
}: {
  tone: NoticeTone;
  children: ReactNode;
  action?: { label: string; onClick: () => void };
}) {
  const style = NOTICE_TONE[tone];
  return (
    <div
      className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm ${style.surface}`}
    >
      <div
        role={tone === "error" ? "alert" : "status"}
        className="flex min-w-0 flex-1 items-start gap-2.5"
      >
        <style.Glyph
          aria-hidden="true"
          className={`mt-0.5 h-4 w-4 shrink-0 ${style.icon}`}
        />
        <p className="min-w-0 flex-1 break-words font-medium text-foreground">
          {children}
        </p>
      </div>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className={`shrink-0 rounded-md border border-border bg-card px-2.5 py-1 font-medium text-foreground text-xs transition-colors hover:bg-[var(--accent-surface-soft)] ${focusRing}`}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

function FirstRun({
  hasPage,
  onPick,
}: {
  hasPage: boolean;
  onPick: (seed: string) => void;
}) {
  const starters = hasPage ? [PAGE_STARTER, ...STARTERS] : STARTERS;
  return (
    <div className="px-6 pt-6 pb-4">
      <h3 className="font-semibold text-[length:var(--font-size-lg)] text-foreground leading-snug">
        What should the assistant do?
      </h3>
      <p className="mt-1.5 text-[length:var(--font-size-base)] text-muted-foreground leading-[1.5]">
        It creates workflows, checks usage, and manages API keys. Changes wait
        for your approval.
      </p>
      <ul className="mt-5 flex flex-col gap-2">
        {starters.map((starter) => (
          <li key={starter.label}>
            <button
              type="button"
              onClick={() => onPick(starter.seed)}
              className={`group flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-border bg-background px-3.5 py-2.5 text-left text-foreground text-sm transition-colors hover:bg-[var(--accent-surface-soft)] ${focusRing}`}
            >
              {starter.label}
              <ArrowUpRight
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
              />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
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
 * An absent context window or price is omitted rather than passed as `undefined`.
 * The catalog's `promptUsdPerMillion` is converted to the picker's per-token
 * `pricing.prompt` wire form; each row then shows a single "$X/M" prompt price.
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
  const row = (
    slug: string,
    label?: string,
    contextTokens?: number,
    promptUsdPerMillion?: number,
  ): CatalogModel => ({
    id: slug,
    name: label ?? slug,
    provider: providerOf(slug),
    supportsTools: true,
    supportsReasoning: false,
    featured: false,
    ...(contextTokens != null ? { contextLength: contextTokens } : {}),
    ...(promptUsdPerMillion != null
      ? { pricing: { prompt: String(promptUsdPerMillion / 1_000_000) } }
      : {}),
  });
  const mapped: CatalogModel[] = models.models.map((m) =>
    row(m.slug, m.label, m.contextTokens, m.promptUsdPerMillion),
  );
  for (const slug of [models.default, selected]) {
    if (slug && !mapped.some((m) => m.id === slug)) mapped.push(row(slug));
  }
  return mapped;
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
  layout = "docked",
  context = null,
  toggleRef,
  navigate,
  balanceUsd = null,
  formatMoney = defaultFormatMoney,
  renderGraph,
  renderProviderIcon,
  toolRenderers,
  renderConfirmedResult,
  composerSeed = null,
  onComposerSeedApplied,
  composerAttachments,
  onComposerSend,
}: AssistantPanelProps) {
  const models = useAssistantModels();
  const threads = useAssistantThreads(userId);
  // A one-shot composer draft from a first-run starter, consumed by the same
  // seed mechanism as the host's `composerSeed` (applied once, then cleared).
  const [starterSeed, setStarterSeed] = useState<string | null>(null);
  // Which surface the conversation area shows: the live chat, or the
  // full-panel history list. The header's history button toggles them.
  const [view, setView] = useState<"chat" | "history">("chat");
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  // The conversation/history scroll container, used to scope the history-view
  // Escape handler and to move focus into the history view when it opens.
  const logRef = useRef<HTMLDivElement | null>(null);

  const pickerModels = useMemo<CatalogModel[]>(
    () => toPickerModels(models, chat.selectedModel),
    [models, chat.selectedModel],
  );
  // `toPickerModels` guarantees both the selected slug and the default a row,
  // so the displayed model is exactly the slug the next turn will send.
  const pickerValue = chat.selectedModel ?? models.default ?? "";

  const { state } = chat;
  // Always-current chat handle, so an async delete can re-check the LIVE
  // thread + status after awaiting (the closure's `state` is render-time stale).
  const chatRef = useRef(chat);
  chatRef.current = chat;

  // When the history view opens, move focus into its search box so keyboard
  // users can type at once and the scoped Escape handler receives the key.
  useEffect(() => {
    if (view !== "history") return;
    const search = logRef.current?.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    (search ?? logRef.current)?.focus();
  }, [view]);

  // In the history view, Escape returns to the conversation (and refocuses the
  // toggle) rather than closing the whole assistant. Scoped to Escapes from
  // inside the history view or the toggle, and handled in the capture phase so
  // it preempts the dock's own Escape-to-close.
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

  // Auto-follow: pin the transcript to the newest content as it streams,
  // yielding when the user scrolls up. The signature moves on every visible
  // transcript change: text growth, a new message, reasoning, the turn status,
  // a tool row's status, and a new proposal card. See `useStickToBottom`.
  const contentSignature = useMemo(() => {
    let sig = `${state.reasoning?.length ?? 0}|${state.status}`;
    for (const m of state.messages) {
      // Thread history is external data; guard so a malformed message can't
      // throw and blank the panel.
      sig += `|${m.text?.length ?? 0}`;
      if (m.tool) sig += `:${m.tool.status}`;
    }
    for (const p of state.pendingProposals) sig += `|p:${p.callId}`;
    return sig;
  }, [
    state.messages,
    state.reasoning,
    state.status,
    state.pendingProposals,
  ]);
  // An empty thread shows the first-run state, which has nothing to follow;
  // open it at the top so a tall first-run state is never clipped.
  const emptyThread = state.messages.length === 0 && state.status !== "streaming";
  const { onScroll: handleConversationScroll } = useStickToBottom(logRef, {
    enabled: view === "chat" && !emptyThread,
    contentSignature,
    streamingId: state.streamingId,
    threadId: state.threadId,
  });
  useLayoutEffect(() => {
    if (emptyThread && logRef.current) logRef.current.scrollTop = 0;
  }, [emptyThread]);

  // Prefer the just-settled turn's balance (from the usage event, immediate)
  // over the injected fetched balance, which may lag a turn behind.
  const effectiveBalance = state.usage?.balanceUsd ?? balanceUsd;
  const errorView = state.error
    ? presentError(state.error.code, state.error.message)
    : null;
  const low = isLowBalance(effectiveBalance) && !errorView;
  const streaming = state.status === "streaming";
  const showContinue =
    state.capped && state.status === "idle" && !chat.restoring && view === "chat";

  const renderProposal = (proposal: (typeof state.pendingProposals)[number]) => (
    <ProposalCard
      proposal={proposal}
      confirming={
        proposal.proposalId ? chat.confirmingIds.has(proposal.proposalId) : false
      }
      onConfirm={() => chat.confirm(proposal)}
      onCancel={() => chat.cancel(proposal)}
      navigate={navigate}
      // Offer in-place connect only when the host wired a handler; otherwise
      // the card keeps its navigate-to-connect-target fallback.
      onConnect={
        chat.canConnectRequirement
          ? (requirement) => chat.connectRequirement(proposal, requirement)
          : undefined
      }
      renderGraph={renderGraph}
      renderProviderIcon={renderProviderIcon}
    />
  );

  const transcriptView: AssistantTranscriptView = {
    messages: state.messages,
    reasoning: state.reasoning,
    streamingId: state.streamingId,
    model: state.model,
    isStreaming: streaming,
    isThinking: assistantIsThinking(state),
    pendingProposals: state.pendingProposals,
    usage: state.usage,
    renderProposal,
  };

  // Entering history loads (or reloads) the thread list; the hook never
  // fetches on mount.
  const toggleHistory = () => {
    if (view === "history") {
      setView("chat");
      return;
    }
    threads.refresh();
    setView("history");
  };

  // Delete a past conversation. Deleting the active thread is refused while it
  // is mid-turn. The list row drops optimistically (in the hook), but the live
  // conversation resets only once the server confirms the delete.
  const deleteThread = async (threadId: string) => {
    const pre = chatRef.current.state;
    if (pre.threadId === threadId && pre.status !== "idle") return;
    if (!window.confirm("Delete this conversation? This can't be undone.")) {
      return;
    }
    const res = await threads.remove(threadId);
    // Re-checked through the ref: the user may have switched threads or
    // started a turn while the delete was in flight.
    const live = chatRef.current.state;
    if (res.ok && live.threadId === threadId && live.status === "idle") {
      chatRef.current.reset();
    }
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-card">
      {/* History sits on the outer edge, under the floating toggle's spot: a
          second click right after opening toggles history, never resets the
          conversation. */}
      <header className="flex h-[var(--assistant-header-height,3.5rem)] shrink-0 items-center gap-2 border-border border-b px-3">
        {layout === "docked" && (
          <AssistantPanelToggle open onToggle={onClose} buttonRef={toggleRef} />
        )}
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="truncate font-semibold text-[length:var(--font-size-base)] text-foreground leading-tight">
              Assistant
            </h2>
            {effectiveBalance != null && (
              <span
                aria-label="Your credit balance"
                className="shrink-0 text-muted-foreground text-xs tabular-nums"
              >
                {formatMoney(effectiveBalance)}
              </span>
            )}
          </div>
          {context && (
            <p
              className="truncate text-muted-foreground text-xs leading-snug"
              title={`The assistant sees ${context.path}`}
            >
              <span className="sr-only">Looking at </span>
              {context.label}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            chat.reset();
            setView("chat");
          }}
          aria-label="New chat"
          title="New chat"
          className={HEADER_BUTTON}
        >
          <MessageSquarePlus aria-hidden="true" className="h-[18px] w-[18px]" />
        </button>
        <button
          ref={historyButtonRef}
          type="button"
          onClick={toggleHistory}
          aria-label="Chat history"
          aria-pressed={view === "history"}
          title="Chat history"
          className={`${HEADER_BUTTON} ${view === "history" ? "bg-[var(--accent-surface-soft)] text-foreground" : ""}`}
        >
          <History aria-hidden="true" className="h-[18px] w-[18px]" />
        </button>
        {layout === "sheet" && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close assistant"
            title="Close assistant"
            className={HEADER_BUTTON}
          >
            <X aria-hidden="true" className="h-[18px] w-[18px]" />
          </button>
        )}
      </header>

      <div
        ref={logRef}
        tabIndex={-1}
        aria-label="Conversation"
        onScroll={handleConversationScroll}
        // The live region is the chat view only, so the history view's search
        // box and buttons are not announced as conversation activity.
        role={view === "chat" ? "log" : undefined}
        aria-live={view === "chat" ? "polite" : undefined}
        className="min-h-0 flex-1 overflow-y-auto focus:outline-none"
      >
        {view === "history" ? (
          <AssistantHistory
            threads={threads.threads}
            loaded={threads.loaded}
            error={threads.error}
            onRetry={threads.refresh}
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
          <div className="mx-auto w-full max-w-3xl">
            <AssistantTranscript
              view={transcriptView}
              toolRenderers={toolRenderers}
              renderConfirmedResult={renderConfirmedResult}
              emptyState={
                <FirstRun hasPage={context != null} onPick={setStarterSeed} />
              }
            />
          </div>
        )}
      </div>

      {/* Notices sit in the composer column, as in the main chat. */}
      <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 p-3">
        {errorView && (
          <Notice
            tone="error"
            action={
              errorView.cta
                ? {
                    label: errorView.cta.label,
                    onClick: () => navigate?.(errorView.cta?.to ?? ""),
                  }
                : undefined
            }
          >
            {errorView.message}
          </Notice>
        )}
        {low && (
          <Notice
            tone="warning"
            action={{
              label: "Add credits",
              onClick: () => navigate?.("/app/billing"),
            }}
          >
            Your credit balance is running low.
          </Notice>
        )}
        {showContinue && (
          // A capped turn stopped mid-plan. "continue" is an ordinary user
          // message: the server replays the thread's full history every turn,
          // so the model resumes the interrupted work from context.
          <Notice
            tone="info"
            action={{ label: "Continue", onClick: () => chat.send("continue") }}
          >
            Paused at the step limit.
          </Notice>
        )}
        <ChatComposer
          onSend={(message) => {
            setView("chat");
            chat.send(message);
            onComposerSend?.(message);
          }}
          onCancel={chat.stop}
          isStreaming={streaming}
          disabled={chat.restoring || state.status === "awaiting_confirm"}
          placeholder={
            state.status === "awaiting_confirm"
              ? "Confirm or cancel the proposal above to continue"
              : "Message the assistant…"
          }
          sendVariant="icon"
          // The starter seed is panel-local; the host's composerSeed wins only
          // when no starter seed is pending. Both consume once.
          seed={starterSeed ?? composerSeed}
          onSeedApplied={() => {
            setStarterSeed(null);
            onComposerSeedApplied?.();
          }}
          onAttach={composerAttachments?.onAttach}
          onAttachFolder={composerAttachments?.onAttachFolder}
          pendingFiles={composerAttachments?.pendingFiles}
          onRemoveFile={composerAttachments?.onRemoveFile}
          accept={composerAttachments?.accept}
          controls={
            pickerModels.length > 0 ? (
              <ModelPicker
                variant="quiet"
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
