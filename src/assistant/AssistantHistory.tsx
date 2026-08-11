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

import { Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { AsyncView, type AsyncResourceState } from "../web-react/async";
import { timeAgo } from "./time-ago";
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

/**
 * Parse an ISO timestamp to epoch ms for `timeAgo`. Returns null for an absent
 * or unparseable value, so a row simply omits its time rather than rendering
 * "NaN" — thread summaries can carry an empty `updatedAt` on older servers.
 */
function parsedTime(iso: string): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function AssistantHistory({
  threads,
  loaded,
  error,
  onRetry,
  activeThreadId,
  activeBusy,
  canRemove,
  onSelect,
  onDelete,
}: AssistantHistoryProps) {
  const [query, setQuery] = useState("");

  // Most-recently-updated first; an unparseable/absent time sorts last. The
  // spread keeps the hook's array intact, and a stable sort preserves the
  // server's order among equal times.
  const sorted = useMemo(
    () =>
      [...threads].sort((a, b) => {
        const ta = parsedTime(a.updatedAt);
        const tb = parsedTime(b.updatedAt);
        // Most-recently-updated first; rows without a parseable time sort last,
        // and two such rows keep their existing order.
        if (ta === null && tb === null) return 0;
        if (ta === null) return 1;
        if (tb === null) return -1;
        return tb - ta;
      }),
    [threads],
  );

  const trimmed = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      trimmed
        ? // Match the title as displayed, so searching "untitled" finds the
          // rows that render as "Untitled conversation".
          sorted.filter((t) =>
            (t.title ?? "Untitled conversation")
              .toLowerCase()
              .includes(trimmed),
          )
        : sorted,
    [sorted, trimmed],
  );

  // The load's outcome as the shared contract's variants. `error` wins over
  // everything: a failed fetch leaves whatever list was last known, and
  // rendering that as the answer is the confusion this branch exists to end.
  const state: AsyncResourceState<AssistantThreadSummary[]> = error
    ? { status: "error", message: error, error, retry: onRetry }
    : !loaded
      ? { status: "loading", retry: onRetry }
      : visible.length === 0
        ? { status: "empty", value: visible, retry: onRetry }
        : { status: "ready", value: visible, retry: onRetry };

  return (
    <div className="flex h-full flex-col">
      <div className="border-border border-b p-2">
        <div className="relative">
          <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
            className="w-full rounded-md border border-strong bg-surface-container-high py-1.5 pr-2 pl-8 text-foreground text-sm placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <AsyncView
          state={state}
          loadingLabel="Loading…"
          // The error branch speaks the same dialect as the panel's error
          // banner and the transcript's stream-error row: alert glyph +
          // destructive text, not a muted "empty-looking" paragraph.
          renderError={({ message, retry }) => (
            <div
              role="alert"
              className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center"
            >
              <svg
                className="h-4 w-4 text-destructive"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v4m0 4h.01" />
              </svg>
              <p className="max-w-md text-destructive text-sm">{message}</p>
              <button
                type="button"
                onClick={retry}
                className="rounded border border-destructive/40 bg-card px-2 py-0.5 font-medium text-[11px] text-destructive transition hover:bg-destructive/10"
              >
                Retry
              </button>
            </div>
          )}
          empty={{
            title: trimmed
              ? "No conversations match your search."
              : "No past conversations yet.",
            description: trimmed
              ? undefined
              : "Your chats with the assistant will appear here.",
          }}
        >
          {(rows) => (
            <ul className="py-1">
              {rows.map((t) => {
                const active = t.id === activeThreadId;
                const ms = parsedTime(t.updatedAt);
                const busyActive = active && activeBusy;
                const title = t.title ?? "Untitled conversation";
                return (
                  <li
                    key={t.id}
                    className={`group flex items-center transition-colors hover:bg-accent ${
                      active
                        ? "bg-primary/10 shadow-[inset_2px_0_0_hsl(var(--primary))]"
                        : ""
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(t.id)}
                      className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2 text-left"
                    >
                      <span
                        className={`truncate text-sm ${
                          active
                            ? "font-medium text-foreground"
                            : "text-foreground"
                        }`}
                      >
                        {title}
                      </span>
                      {ms != null && (
                        <span className="text-[11px] text-muted-foreground">
                          {timeAgo(ms)}
                        </span>
                      )}
                    </button>
                    {canRemove && (
                      <button
                        type="button"
                        onClick={() => onDelete(t.id)}
                        disabled={busyActive}
                        aria-label={`Delete conversation: ${title}`}
                        title={
                          busyActive
                            ? "Can't delete while this conversation is active"
                            : "Delete conversation"
                        }
                        // Always visible on touch devices (no hover to reveal it).
                        className="shrink-0 p-2 text-muted-foreground opacity-0 transition [@media(hover:none)]:opacity-100 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </AsyncView>
      </div>
    </div>
  );
}
