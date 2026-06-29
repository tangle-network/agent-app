/**
 * The assistant's conversation history as a full-panel view: a searchable,
 * recency-sorted list of past threads, each showing its title and a relative
 * "last active" time, with inline delete. Replaces the cramped header dropdown —
 * inside an already-narrow side panel, a full-height list is far easier to scan
 * and navigate. Selection, deletion, and refresh are owned by the host panel;
 * this component is presentational and holds only its own search query.
 */

import { Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { timeAgo } from "./time-ago";
import type { AssistantThreadSummary } from "./client";

export interface AssistantHistoryProps {
  threads: AssistantThreadSummary[];
  /** True once a fetch has settled at least once (drives empty-vs-loading copy). */
  loaded: boolean;
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
            className="w-full rounded-md border border-border bg-surface-container-high py-1.5 pr-2 pl-8 text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <p className="px-3 py-6 text-center text-muted-foreground text-xs">
            {!loaded
              ? "Loading…"
              : trimmed
                ? "No conversations match your search."
                : "No past conversations yet."}
          </p>
        ) : (
          <ul className="py-1">
            {visible.map((t) => {
              const active = t.id === activeThreadId;
              const ms = parsedTime(t.updatedAt);
              const busyActive = active && activeBusy;
              const title = t.title ?? "Untitled conversation";
              return (
                <li
                  key={t.id}
                  className={`group flex items-center transition-colors hover:bg-muted/60 ${
                    active ? "bg-primary/10" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(t.id)}
                    className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2 text-left"
                  >
                    <span
                      className={`truncate text-sm ${
                        active ? "font-medium text-foreground" : "text-foreground"
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
      </div>
    </div>
  );
}
