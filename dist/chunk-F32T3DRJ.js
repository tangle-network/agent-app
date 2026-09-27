import {
  OVERLAY_SHADOW,
  PopoverSurface,
  usePopover
} from "./chunk-4I76LTZS.js";
import {
  UNTITLED_SESSION_LABEL,
  mergeSessionPages,
  sessionLabel
} from "./chunk-SJWIZT7B.js";

// src/web-react/session-history.tsx
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
function rethrowAsync(error) {
  queueMicrotask(() => {
    throw error;
  });
}
function useInfiniteScroll(onLoadMore, { enabled, root, rootMargin = "300px" }) {
  const [sentinel, setSentinel] = useState(null);
  const sentinelRef = useCallback((node) => setSentinel(node), []);
  const onLoadMoreRef = useRef(onLoadMore);
  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);
  useEffect(() => {
    if (!sentinel || !enabled) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        try {
          onLoadMoreRef.current();
        } catch (error) {
          rethrowAsync(error);
        }
      },
      { root: root?.current ?? null, rootMargin }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, enabled, root, rootMargin]);
  return sentinelRef;
}
function seedSignature(page) {
  return JSON.stringify({
    nextCursor: page.nextCursor ?? null,
    items: page.items.map((item) => ({
      id: item.id,
      title: item.title,
      updatedAt: item.updatedAt,
      isPinned: Boolean(item.isPinned),
      unread: Boolean(item.unread),
      category: item.category ?? null
    }))
  });
}
function useSessionHistory({
  fetchPage,
  q,
  sort,
  initialPage,
  defaultSort = "newest"
}) {
  const [items, setItems] = useState(initialPage.items);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor ?? null);
  const [phase, setPhase] = useState("idle");
  const [reloadKey, setReloadKey] = useState(0);
  const seqRef = useRef(0);
  const resetAbortRef = useRef(null);
  const loadMoreAbortRef = useRef(null);
  const loadingMoreRef = useRef(false);
  const lastOpRef = useRef("first");
  const nextCursorRef = useRef(nextCursor);
  nextCursorRef.current = nextCursor;
  const viewRef = useRef({ q, sort, fetchPage });
  viewRef.current = { q, sort, fetchPage };
  const seedRef = useRef(initialPage);
  seedRef.current = initialPage;
  const isDefaultView = q === "" && sort === defaultSort;
  const seedKey = useMemo(() => seedSignature(initialPage), [initialPage]);
  useEffect(() => {
    resetAbortRef.current?.abort();
    loadMoreAbortRef.current?.abort();
    loadingMoreRef.current = false;
    const seq = ++seqRef.current;
    if (isDefaultView && reloadKey === 0) {
      setItems(seedRef.current.items);
      setNextCursor(seedRef.current.nextCursor ?? null);
      setPhase("idle");
      return;
    }
    const controller = new AbortController();
    resetAbortRef.current = controller;
    lastOpRef.current = "first";
    setItems([]);
    setNextCursor(null);
    setPhase("loadingFirst");
    void (async () => {
      try {
        const page = await viewRef.current.fetchPage({ q, sort, cursor: null, signal: controller.signal });
        if (seq !== seqRef.current) return;
        setItems(page.items);
        setNextCursor(page.nextCursor ?? null);
        setPhase("idle");
      } catch {
        if (controller.signal.aborted || seq !== seqRef.current) return;
        setPhase("error");
      }
    })();
    return () => controller.abort();
  }, [q, sort, seedKey, isDefaultView, reloadKey]);
  const loadMore = useCallback(() => {
    const cursor = nextCursorRef.current;
    if (!cursor || loadingMoreRef.current) return;
    const { q: currentQ, sort: currentSort, fetchPage: currentFetch } = viewRef.current;
    const seq = seqRef.current;
    loadingMoreRef.current = true;
    lastOpRef.current = "more";
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    setPhase("loadingMore");
    void (async () => {
      try {
        const page = await currentFetch({ q: currentQ, sort: currentSort, cursor, signal: controller.signal });
        if (seq !== seqRef.current) return;
        setItems((prev) => mergeSessionPages(prev, page.items));
        setNextCursor(page.nextCursor ?? null);
        setPhase("idle");
      } catch {
        if (controller.signal.aborted || seq !== seqRef.current) return;
        setPhase("error");
      } finally {
        if (seq === seqRef.current) loadingMoreRef.current = false;
      }
    })();
  }, []);
  const retry = useCallback(() => {
    if (lastOpRef.current === "more") loadMore();
    else setReloadKey((key) => key + 1);
  }, [loadMore]);
  const reload = useCallback(() => {
    setReloadKey((key) => key + 1);
  }, []);
  useEffect(
    () => () => {
      resetAbortRef.current?.abort();
      loadMoreAbortRef.current?.abort();
    },
    []
  );
  return {
    items,
    hasMore: nextCursor !== null,
    isLoadingFirst: phase === "loadingFirst",
    isLoadingMore: phase === "loadingMore",
    isError: phase === "error",
    loadMore,
    retry,
    reload
  };
}
var DEFAULT_LABELS = {
  renameTitle: "Rename session",
  renameField: "Title",
  renameSubmit: "Save",
  deleteTitle: "Delete session?",
  deleteBody: (title) => `This will permanently delete \u201C${title}\u201D and its messages. This cannot be undone.`,
  deleteSubmit: "Delete",
  cancel: "Cancel",
  renamed: "Session renamed",
  deleted: "Session deleted",
  renameFailed: "Failed to rename session",
  deleteFailed: "Failed to delete session"
};
function useSessionActions({
  renameSession,
  deleteSession,
  onChanged,
  onDeletedCurrent,
  currentSessionId,
  notify,
  labels
}) {
  const text = { ...DEFAULT_LABELS, ...labels };
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const openRename = useCallback((session) => {
    setError(null);
    setRenameTarget(session);
    setRenameValue(session.title ?? "");
  }, []);
  const openDelete = useCallback((session) => {
    setError(null);
    setDeleteTarget(session);
  }, []);
  const submitRename = useCallback(async () => {
    if (!renameTarget) return;
    const title = renameValue.trim();
    if (!title || title === renameTarget.title) {
      setRenameTarget(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await renameSession(renameTarget.id, title);
      setRenameTarget(null);
      notify?.("success", text.renamed);
      onChanged?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : text.renameFailed;
      setError(message);
      notify?.("error", message);
    } finally {
      setBusy(false);
    }
  }, [renameTarget, renameValue, renameSession, notify, onChanged, text.renamed, text.renameFailed]);
  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const deletingCurrent = currentSessionId != null && deleteTarget.id === currentSessionId;
    setBusy(true);
    setError(null);
    try {
      await deleteSession(deleteTarget.id);
      setDeleteTarget(null);
      notify?.("success", text.deleted);
      onChanged?.();
      if (deletingCurrent) onDeletedCurrent?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : text.deleteFailed;
      setError(message);
      notify?.("error", message);
    } finally {
      setBusy(false);
    }
  }, [deleteTarget, currentSessionId, deleteSession, notify, onChanged, onDeletedCurrent, text.deleted, text.deleteFailed]);
  const dialogs = /* @__PURE__ */ jsxs(Fragment, { children: [
    renameTarget && /* @__PURE__ */ jsxs(
      SessionDialog,
      {
        title: text.renameTitle,
        onClose: () => setRenameTarget(null),
        busy,
        error,
        footer: /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsx(DialogButton, { onClick: () => setRenameTarget(null), disabled: busy, variant: "ghost", children: text.cancel }),
          /* @__PURE__ */ jsx(DialogButton, { onClick: () => void submitRename(), disabled: busy || !renameValue.trim(), children: text.renameSubmit })
        ] }),
        children: [
          /* @__PURE__ */ jsx("label", { htmlFor: "agent-app-rename-session", className: "text-xs text-muted-foreground", children: text.renameField }),
          /* @__PURE__ */ jsx(
            "input",
            {
              id: "agent-app-rename-session",
              value: renameValue,
              autoFocus: true,
              onChange: (e) => setRenameValue(e.target.value),
              onKeyDown: (e) => {
                if (e.key === "Enter" && !busy) {
                  e.preventDefault();
                  void submitRename();
                }
              },
              className: "mt-1.5 h-9 w-full rounded-md border border-strong bg-background px-3 text-sm text-foreground"
            }
          )
        ]
      }
    ),
    deleteTarget && /* @__PURE__ */ jsx(
      SessionDialog,
      {
        title: text.deleteTitle,
        onClose: () => setDeleteTarget(null),
        busy,
        error,
        footer: /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsx(DialogButton, { onClick: () => setDeleteTarget(null), disabled: busy, variant: "ghost", children: text.cancel }),
          /* @__PURE__ */ jsx(DialogButton, { onClick: () => void confirmDelete(), disabled: busy, variant: "destructive", children: text.deleteSubmit })
        ] }),
        children: /* @__PURE__ */ jsx("p", { className: "text-sm text-muted-foreground", children: text.deleteBody(sessionLabel(deleteTarget)) })
      }
    )
  ] });
  return { openRename, openDelete, dialogs, busy };
}
function DialogButton({
  children,
  onClick,
  disabled,
  variant = "primary"
}) {
  const tone = variant === "ghost" ? "text-muted-foreground hover:bg-accent hover:text-foreground" : variant === "destructive" ? "bg-destructive text-destructive-foreground hover:opacity-90" : "bg-primary text-primary-foreground hover:opacity-90";
  return /* @__PURE__ */ jsx(
    "button",
    {
      type: "button",
      onClick,
      disabled,
      className: `h-9 rounded-md px-3 text-sm font-medium transition disabled:opacity-50 ${tone}`,
      children
    }
  );
}
function SessionDialog({
  title,
  children,
  footer,
  onClose,
  busy,
  error
}) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  return /* @__PURE__ */ jsxs("div", { className: "fixed inset-0 z-50 flex items-center justify-center p-4", children: [
    /* @__PURE__ */ jsx(
      "div",
      {
        className: "absolute inset-0 bg-black/50",
        onClick: () => {
          if (!busy) onClose();
        },
        "aria-hidden": true
      }
    ),
    /* @__PURE__ */ jsxs(
      "div",
      {
        role: "dialog",
        "aria-modal": "true",
        "aria-label": title,
        className: `relative w-full max-w-sm rounded-xl border border-card-edge bg-popover p-5 ${OVERLAY_SHADOW}`,
        children: [
          /* @__PURE__ */ jsx("h2", { className: "text-sm font-semibold text-foreground", children: title }),
          /* @__PURE__ */ jsx("div", { className: "mt-3", children }),
          error && /* @__PURE__ */ jsx("p", { role: "alert", className: "mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive", children: error }),
          /* @__PURE__ */ jsx("div", { className: "mt-5 flex justify-end gap-2", children: footer })
        ]
      }
    )
  ] });
}
function AnchorLink({ to, className, children }) {
  return /* @__PURE__ */ jsx("a", { href: to, className, children });
}
var MINUTE = 6e4;
var HOUR = 60 * MINUTE;
var DAY = 24 * HOUR;
function formatSessionTimestamp(isoDate) {
  if (!isoDate) return "";
  const at = Date.parse(isoDate);
  if (Number.isNaN(at)) return "";
  const delta = Date.now() - at;
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d ago`;
  return new Date(at).toLocaleDateString(void 0, { month: "short", day: "numeric" });
}
function SkeletonRows() {
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("span", { role: "status", "aria-live": "polite", "aria-busy": true, className: "sr-only", children: "Loading sessions\u2026" }),
    /* @__PURE__ */ jsx("div", { className: "flex flex-col gap-0.5", "aria-hidden": true, children: Array.from({ length: 8 }).map((_, i) => /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3 px-3 py-2.5", children: [
      /* @__PURE__ */ jsx("div", { className: "h-4 w-4 animate-pulse rounded bg-muted" }),
      /* @__PURE__ */ jsx("div", { className: "h-4 w-1/2 animate-pulse rounded bg-muted" }),
      /* @__PURE__ */ jsx("div", { className: "ml-auto h-3 w-12 animate-pulse rounded bg-muted" })
    ] }, i)) })
  ] });
}
function MessageIcon({ className }) {
  return /* @__PURE__ */ jsx("svg", { viewBox: "0 0 24 24", className, fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx("path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }) });
}
function SessionHistoryPanel({
  history,
  hasAnySessions,
  query,
  onQueryChange,
  sort,
  onSortChange,
  hrefForSession,
  linkComponent: Link = AnchorLink,
  respondingSessionIds,
  onRename,
  onDelete,
  onBulkAction,
  renameLabel = "Rename",
  deleteLabel = "Delete",
  extraActions,
  newSessionHref,
  title = "History",
  untitledLabel = UNTITLED_SESSION_LABEL,
  emptyTitle = "No sessions yet",
  emptyDescription = "Your chat sessions will show up here once you start one.",
  formatTimestamp = formatSessionTimestamp,
  contentWidth = "reading",
  className
}) {
  const scrollRef = useRef(null);
  const sentinelRef = useInfiniteScroll(history.loadMore, {
    enabled: history.hasMore && !history.isLoadingMore && !history.isError,
    root: scrollRef,
    rootMargin: "300px"
  });
  const searchTerm = query.trim();
  const isSearching = searchTerm.length > 0;
  const column = contentWidth === "full" ? "w-full" : "mx-auto w-full max-w-4xl";
  const [selectedIds, setSelectedIds] = useState(/* @__PURE__ */ new Set());
  const [ageDays, setAgeDays] = useState("30");
  const [bulkTarget, setBulkTarget] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState(null);
  useEffect(() => {
    setSelectedIds(/* @__PURE__ */ new Set());
  }, [searchTerm, sort]);
  useEffect(() => {
    const visible = new Set(history.items.map((item) => item.id));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => visible.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [history.items]);
  const selectedCount = selectedIds.size;
  const allVisibleSelected = history.items.length > 0 && history.items.every((item) => selectedIds.has(item.id));
  const parsedAgeDays = Number(ageDays);
  const validAgeDays = Number.isInteger(parsedAgeDays) && parsedAgeDays >= 1 && parsedAgeDays <= 36500;
  const openBulkAction = useCallback((action) => {
    const verb = deleteLabel.toLowerCase();
    if (action.kind === "selected") {
      setBulkTarget({
        action,
        title: `${deleteLabel} selected sessions?`,
        body: `${verb === "delete" ? "This permanently removes" : `This ${verb}s`} ${action.ids.length} selected session${action.ids.length === 1 ? "" : "s"} and its messages.`
      });
      return;
    }
    const range = action.kind === "older-than" ? `older than ${action.days} days` : `from the last ${action.days} days`;
    setBulkTarget({
      action,
      title: `${deleteLabel} sessions ${range}?`,
      body: "This applies to every matching session in this workspace, including sessions not currently loaded in this list."
    });
  }, [deleteLabel]);
  const confirmBulkAction = useCallback(async () => {
    if (!bulkTarget || !onBulkAction) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      await onBulkAction(bulkTarget.action);
      setBulkTarget(null);
      setSelectedIds(/* @__PURE__ */ new Set());
      history.reload();
    } catch (error) {
      setBulkError(error instanceof Error ? error.message : `Could not ${deleteLabel.toLowerCase()} sessions`);
    } finally {
      setBulkBusy(false);
    }
  }, [bulkTarget, deleteLabel, history, onBulkAction]);
  return /* @__PURE__ */ jsxs("div", { className: `flex min-h-0 min-w-0 flex-1 flex-col ${className ?? ""}`, children: [
    /* @__PURE__ */ jsx("header", { className: "flex h-14 shrink-0 items-center border-b border-border px-4 sm:px-6", children: /* @__PURE__ */ jsxs("div", { className: `flex items-center gap-3 px-3 ${column}`, children: [
      /* @__PURE__ */ jsx("h1", { className: "flex-1 truncate text-sm font-semibold text-foreground", children: title }),
      newSessionHref && /* @__PURE__ */ jsxs(
        Link,
        {
          to: newSessionHref,
          className: "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition hover:opacity-90",
          children: [
            /* @__PURE__ */ jsx("span", { "aria-hidden": true, className: "text-sm leading-none", children: "+" }),
            "New chat"
          ]
        }
      )
    ] }) }),
    /* @__PURE__ */ jsxs("div", { ref: scrollRef, className: "min-h-0 flex-1 overflow-y-auto", children: [
      hasAnySessions && /* @__PURE__ */ jsxs("div", { className: "sticky top-0 z-10 bg-background px-4 sm:px-6", children: [
        /* @__PURE__ */ jsxs("div", { className: `flex flex-col gap-2 px-3 pb-3 pt-4 sm:flex-row sm:items-center sm:gap-3 ${column}`, children: [
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "search",
              value: query,
              onChange: (e) => onQueryChange(e.target.value),
              placeholder: "Search your sessions\u2026",
              "aria-label": "Search sessions",
              className: "h-9 min-w-0 appearance-none rounded-md border border-strong bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground sm:flex-1 [&::-webkit-search-cancel-button]:appearance-none"
            }
          ),
          /* @__PURE__ */ jsxs(
            "select",
            {
              value: sort,
              onChange: (e) => onSortChange(e.target.value),
              "aria-label": "Sort sessions",
              className: "h-9 shrink-0 appearance-none rounded-md border border-strong bg-card px-2 text-sm text-foreground sm:w-[132px]",
              children: [
                /* @__PURE__ */ jsx("option", { value: "newest", children: "Newest" }),
                /* @__PURE__ */ jsx("option", { value: "oldest", children: "Oldest" })
              ]
            }
          )
        ] }),
        onBulkAction && /* @__PURE__ */ jsxs("div", { className: `flex flex-col gap-2 border-t border-border px-3 py-3 ${column}`, children: [
          /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                onClick: () => setSelectedIds(new Set(history.items.map((item) => item.id))),
                disabled: allVisibleSelected || history.items.length === 0,
                className: "h-8 rounded-md border border-border px-2.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50",
                children: "Select all"
              }
            ),
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                onClick: () => setSelectedIds(/* @__PURE__ */ new Set()),
                disabled: selectedCount === 0,
                className: "h-8 rounded-md border border-border px-2.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50",
                children: "Deselect all"
              }
            ),
            /* @__PURE__ */ jsxs("span", { className: "text-xs text-muted-foreground", "aria-live": "polite", children: [
              selectedCount,
              " selected"
            ] }),
            selectedCount > 0 && /* @__PURE__ */ jsxs(
              "button",
              {
                type: "button",
                onClick: () => openBulkAction({ kind: "selected", ids: [...selectedIds] }),
                className: "h-8 rounded-md bg-destructive px-2.5 text-xs font-medium text-destructive-foreground transition hover:opacity-90",
                children: [
                  deleteLabel,
                  " selected"
                ]
              }
            )
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [
            /* @__PURE__ */ jsx("label", { htmlFor: "agent-app-session-age", className: "text-xs text-muted-foreground", children: "Session age" }),
            /* @__PURE__ */ jsx(
              "input",
              {
                id: "agent-app-session-age",
                type: "number",
                min: 1,
                max: 36500,
                value: ageDays,
                onChange: (event) => setAgeDays(event.target.value),
                "aria-invalid": ageDays.length > 0 && !validAgeDays,
                className: "h-8 w-20 rounded-md border border-strong bg-card px-2 text-xs tabular-nums text-foreground"
              }
            ),
            /* @__PURE__ */ jsx("span", { className: "text-xs text-muted-foreground", children: "days" }),
            /* @__PURE__ */ jsxs(
              "button",
              {
                type: "button",
                onClick: () => openBulkAction({ kind: "older-than", days: parsedAgeDays }),
                disabled: !validAgeDays,
                className: "h-8 rounded-md border border-border px-2.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50",
                children: [
                  deleteLabel,
                  " older"
                ]
              }
            ),
            /* @__PURE__ */ jsxs(
              "button",
              {
                type: "button",
                onClick: () => openBulkAction({ kind: "newer-than", days: parsedAgeDays }),
                disabled: !validAgeDays,
                className: "h-8 rounded-md border border-border px-2.5 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50",
                children: [
                  deleteLabel,
                  " recent"
                ]
              }
            )
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsx("div", { className: `px-4 pb-8 pt-1 sm:px-6 ${column}`, children: !hasAnySessions ? /* @__PURE__ */ jsxs("div", { className: "flex min-h-[50vh] flex-col items-center justify-center gap-2 text-center", children: [
        /* @__PURE__ */ jsx("p", { className: "text-sm font-medium text-foreground", children: emptyTitle }),
        /* @__PURE__ */ jsx("p", { className: "max-w-xs text-xs text-muted-foreground", children: emptyDescription })
      ] }) : history.isLoadingFirst ? /* @__PURE__ */ jsx(SkeletonRows, {}) : history.items.length === 0 ? history.isError ? /* @__PURE__ */ jsx(ErrorBlock, { onRetry: history.retry, message: "Couldn\u2019t load your sessions." }) : isSearching ? /* @__PURE__ */ jsxs("p", { className: "py-16 text-center text-sm text-muted-foreground", children: [
        "No sessions match \u201C",
        searchTerm,
        "\u201D."
      ] }) : /* @__PURE__ */ jsx("p", { className: "py-16 text-center text-sm text-muted-foreground", children: "No sessions remain." }) : /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-0.5", children: [
        history.items.map((session) => /* @__PURE__ */ jsx(
          SessionRow,
          {
            session,
            href: hrefForSession(session.id),
            Link,
            responding: respondingSessionIds?.has(session.id) ?? false,
            untitledLabel,
            timestamp: formatTimestamp(session.updatedAt),
            onRename,
            onDelete,
            selectable: Boolean(onBulkAction),
            selected: selectedIds.has(session.id),
            onSelectedChange: (selected) => {
              setSelectedIds((current) => {
                const next = new Set(current);
                if (selected) next.add(session.id);
                else next.delete(session.id);
                return next;
              });
            },
            renameLabel,
            deleteLabel,
            extraActions
          },
          session.id
        )),
        history.isError ? /* @__PURE__ */ jsx(ErrorBlock, { onRetry: history.retry, message: "Couldn\u2019t load more sessions.", inline: true }) : history.hasMore ? /* @__PURE__ */ jsx("div", { ref: sentinelRef, className: "flex items-center justify-center py-6", children: history.isLoadingMore && /* @__PURE__ */ jsx("span", { role: "status", "aria-live": "polite", "aria-busy": true, className: "text-xs text-muted-foreground", children: "Loading\u2026" }) }) : null
      ] }) })
    ] }),
    bulkTarget && /* @__PURE__ */ jsx(
      SessionDialog,
      {
        title: bulkTarget.title,
        onClose: () => {
          if (!bulkBusy) {
            setBulkTarget(null);
            setBulkError(null);
          }
        },
        busy: bulkBusy,
        error: bulkError,
        footer: /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsx(
            DialogButton,
            {
              onClick: () => {
                setBulkTarget(null);
                setBulkError(null);
              },
              disabled: bulkBusy,
              variant: "ghost",
              children: "Cancel"
            }
          ),
          /* @__PURE__ */ jsx(DialogButton, { onClick: () => void confirmBulkAction(), disabled: bulkBusy, variant: "destructive", children: bulkBusy ? "Working\u2026" : deleteLabel })
        ] }),
        children: /* @__PURE__ */ jsx("p", { className: "text-sm text-muted-foreground", children: bulkTarget.body })
      }
    )
  ] });
}
function ErrorBlock({ message, onRetry, inline }) {
  return /* @__PURE__ */ jsxs(
    "div",
    {
      className: inline ? "flex items-center justify-center gap-3 py-6 text-sm text-muted-foreground" : "flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center",
      children: [
        /* @__PURE__ */ jsx("span", { className: "text-sm text-muted-foreground", children: message }),
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            onClick: onRetry,
            className: "h-8 rounded-md border border-border px-3 text-xs font-medium text-foreground transition hover:bg-accent",
            children: "Retry"
          }
        )
      ]
    }
  );
}
function SessionRow({
  session,
  href,
  Link,
  responding,
  untitledLabel,
  timestamp,
  onRename,
  onDelete,
  renameLabel,
  deleteLabel,
  extraActions,
  selectable,
  selected,
  onSelectedChange
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const panelId = useId();
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(menuOpen, setMenuOpen);
  const extras = extraActions?.(session) ?? [];
  const hasMenu = Boolean(onRename) || Boolean(onDelete) || extras.length > 0;
  const showUnread = Boolean(session.unread) && !responding;
  return /* @__PURE__ */ jsxs("div", { className: `group relative flex items-center gap-2 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent ${selected ? "bg-primary/10" : ""}`, children: [
    selectable && /* @__PURE__ */ jsx(
      "input",
      {
        type: "checkbox",
        checked: selected,
        onChange: (event) => onSelectedChange(event.target.checked),
        "aria-label": `Select ${sessionLabel(session, untitledLabel)}`,
        className: "h-4 w-4 shrink-0 rounded border-border accent-primary"
      }
    ),
    /* @__PURE__ */ jsxs(Link, { to: href, className: "flex min-w-0 flex-1 items-center gap-3", children: [
      showUnread && /* @__PURE__ */ jsx("span", { className: "h-1.5 w-1.5 shrink-0 rounded-full bg-primary", "aria-hidden": true }),
      /* @__PURE__ */ jsx(MessageIcon, { className: "h-4 w-4 shrink-0 text-muted-foreground" }),
      /* @__PURE__ */ jsx(
        "span",
        {
          className: `truncate text-sm ${responding ? "text-muted-foreground" : "text-foreground"} ${showUnread ? "font-semibold" : ""}`,
          ...responding ? { role: "status", "aria-label": "Agent responding" } : {},
          children: sessionLabel(session, untitledLabel)
        }
      )
    ] }),
    /* @__PURE__ */ jsx("span", { className: "shrink-0 text-xs tabular-nums text-muted-foreground", children: timestamp }),
    hasMenu && /* @__PURE__ */ jsxs("div", { ref: containerRef, className: "relative shrink-0", children: [
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          ...triggerProps,
          "aria-label": "Session actions",
          "aria-controls": menuOpen ? panelId : void 0,
          onClick: () => setMenuOpen((open) => !open),
          className: "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 aria-expanded:opacity-100",
          children: /* @__PURE__ */ jsx("span", { "aria-hidden": true, className: "text-base leading-none", children: "\u22EF" })
        }
      ),
      /* @__PURE__ */ jsxs(
        PopoverSurface,
        {
          open: menuOpen,
          id: panelId,
          role: "menu",
          triggerRef,
          panelRef,
          className: `w-36 overflow-hidden rounded-md border border-card-edge bg-popover py-1 ${OVERLAY_SHADOW}`,
          children: [
            onRename && /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                role: "menuitem",
                onClick: () => {
                  setMenuOpen(false);
                  onRename(session);
                },
                className: "block w-full px-3 py-1.5 text-left text-xs text-foreground transition hover:bg-accent",
                children: renameLabel
              }
            ),
            extras.map((action) => /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                role: "menuitem",
                onClick: () => {
                  setMenuOpen(false);
                  action.onSelect();
                },
                className: `block w-full px-3 py-1.5 text-left text-xs transition ${action.destructive ? "text-destructive hover:bg-destructive/10" : "text-foreground hover:bg-accent"}`,
                children: action.label
              },
              action.id
            )),
            onDelete && /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                role: "menuitem",
                onClick: () => {
                  setMenuOpen(false);
                  onDelete(session);
                },
                className: "block w-full px-3 py-1.5 text-left text-xs text-destructive transition hover:bg-destructive/10",
                children: deleteLabel
              }
            )
          ]
        }
      )
    ] })
  ] });
}

export {
  useInfiniteScroll,
  useSessionHistory,
  useSessionActions,
  formatSessionTimestamp,
  SessionHistoryPanel
};
//# sourceMappingURL=chunk-F32T3DRJ.js.map