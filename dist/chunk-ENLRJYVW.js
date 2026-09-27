import {
  parseReviewQueueItem
} from "./chunk-GEYACSFW.js";
import {
  persistedPartToWorkProduct
} from "./chunk-ZVEEWGDK.js";

// src/web-react/work-product.tsx
import { useCallback, useEffect, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
var STATE_LABELS = {
  intake: "Intake",
  missing_info: "Missing info",
  working: "Working",
  ready_for_review: "Ready for review",
  changes_requested: "Changes requested",
  approved: "Approved",
  blocked: "Blocked"
};
var STATE_TONES = {
  intake: "bg-secondary text-muted-foreground",
  missing_info: "bg-warning/10 text-warning",
  working: "bg-primary/10 text-primary",
  ready_for_review: "bg-success/10 text-success",
  changes_requested: "bg-warning/10 text-warning",
  approved: "bg-success/10 text-success",
  blocked: "bg-destructive/10 text-destructive"
};
var STATUS_LABELS = {
  draft: "Draft",
  blocked: "Blocked",
  ready: "Ready for review",
  changes_requested: "Changes requested",
  approved: "Approved",
  superseded: "Superseded"
};
var STATUS_TONES = {
  draft: "bg-primary/10 text-primary",
  blocked: "bg-destructive/10 text-destructive",
  ready: "bg-success/10 text-success",
  changes_requested: "bg-warning/10 text-warning",
  approved: "bg-success/10 text-success",
  superseded: "bg-secondary text-muted-foreground"
};
function reviewQueueStateLabel(state) {
  return STATE_LABELS[state];
}
function workProductStatusLabel(status) {
  return STATUS_LABELS[status];
}
function StatePill({ state }) {
  return /* @__PURE__ */ jsx("span", { className: `inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATE_TONES[state]}`, children: STATE_LABELS[state] });
}
function StatusPill({ status }) {
  return /* @__PURE__ */ jsx("span", { className: `inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONES[status]}`, children: STATUS_LABELS[status] });
}
function workProductPartsFromMessageParts(parts) {
  if (!parts) return [];
  const out = [];
  for (const part of parts) {
    const typed = persistedPartToWorkProduct(part);
    if (typed) out.push(typed);
  }
  return out;
}
function WorkProductCard({ part, onOpen, className }) {
  return /* @__PURE__ */ jsxs(
    "div",
    {
      className: `flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 ${className ?? ""}`,
      "data-work-product-id": part.ref.id,
      children: [
        /* @__PURE__ */ jsx("span", { className: "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary", children: /* @__PURE__ */ jsxs("svg", { viewBox: "0 0 24 24", className: "h-4 w-4", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
          /* @__PURE__ */ jsx("path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" }),
          /* @__PURE__ */ jsx("polyline", { points: "14 2 14 8 20 8" }),
          /* @__PURE__ */ jsx("path", { d: "m9 15 2 2 4-4" })
        ] }) }),
        /* @__PURE__ */ jsxs("div", { className: "min-w-0 flex-1", children: [
          /* @__PURE__ */ jsx("p", { className: "truncate text-sm font-semibold text-foreground", children: part.title }),
          /* @__PURE__ */ jsxs("p", { className: "text-xs text-muted-foreground", children: [
            part.kind && /* @__PURE__ */ jsx("span", { className: "font-mono", children: part.kind }),
            part.kind && " \xB7 ",
            "v",
            part.ref.version
          ] })
        ] }),
        /* @__PURE__ */ jsx(StatusPill, { status: part.status }),
        onOpen && /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            onClick: () => onOpen(part),
            className: "rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition hover:bg-accent",
            children: "Review"
          }
        )
      ]
    }
  );
}
function mergeReviewQueuePages(existing, incoming) {
  const byScope = /* @__PURE__ */ new Map();
  for (const item of existing) byScope.set(item.scopeKey, item);
  for (const item of incoming) byScope.set(item.scopeKey, item);
  return [...byScope.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
function ReviewQueuePanel({
  fetchQueue,
  onSelect,
  title = "Review queue",
  emptyLabel = "Nothing awaiting review.",
  className
}) {
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(void 0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(
    async (from) => {
      setLoading(true);
      setError(null);
      try {
        const page = await fetchQueue(from);
        const validated = page.items.map((item) => parseReviewQueueItem(item)).filter((item) => item !== null);
        setItems((prev) => mergeReviewQueuePages(from === void 0 ? [] : prev, validated));
        setCursor(page.nextCursor);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [fetchQueue]
  );
  useEffect(() => {
    void load();
  }, [load]);
  return /* @__PURE__ */ jsxs("div", { className: `space-y-2 ${className ?? ""}`, children: [
    /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
      /* @__PURE__ */ jsx("h2", { className: "flex-1 text-sm font-semibold", children: title }),
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          onClick: () => void load(),
          disabled: loading,
          "aria-label": "Refresh",
          className: "rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50",
          children: /* @__PURE__ */ jsxs("svg", { viewBox: "0 0 24 24", className: `h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`, fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
            /* @__PURE__ */ jsx("path", { d: "M21 12a9 9 0 1 1-2.64-6.36" }),
            /* @__PURE__ */ jsx("polyline", { points: "21 3 21 9 15 9" })
          ] })
        }
      )
    ] }),
    error && /* @__PURE__ */ jsx("p", { className: "rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive", children: error }),
    !error && items.length === 0 && !loading && /* @__PURE__ */ jsx("p", { className: "rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground", children: emptyLabel }),
    /* @__PURE__ */ jsx("span", { role: "status", "aria-live": "polite", "aria-busy": loading, className: "sr-only", children: loading ? "Loading review queue\u2026" : "" }),
    /* @__PURE__ */ jsx("ul", { className: "space-y-1.5", "aria-busy": loading, children: items.map((item) => /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        onClick: () => onSelect?.(item),
        className: "flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition hover:border-primary/40 hover:bg-accent",
        children: [
          /* @__PURE__ */ jsxs("div", { className: "min-w-0 flex-1", children: [
            /* @__PURE__ */ jsxs("p", { className: "truncate text-sm font-medium text-foreground", children: [
              item.workProduct?.title ?? item.scopeKey,
              item.workProduct && /* @__PURE__ */ jsxs("span", { className: "ml-1.5 text-xs text-muted-foreground", children: [
                "v",
                item.workProduct.version
              ] })
            ] }),
            /* @__PURE__ */ jsxs("p", { className: "mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground", children: [
              item.workProduct?.kind && /* @__PURE__ */ jsx("span", { className: "font-mono", children: item.workProduct.kind }),
              item.pendingAsk && /* @__PURE__ */ jsxs("span", { children: [
                "asks: ",
                item.pendingAsk.title
              ] }),
              item.blockingExceptions > 0 && /* @__PURE__ */ jsxs("span", { className: "text-destructive", children: [
                item.blockingExceptions,
                " blocking"
              ] }),
              item.failedChecks > 0 && /* @__PURE__ */ jsxs("span", { className: "text-warning", children: [
                item.failedChecks,
                " failed checks"
              ] }),
              item.provenance && item.provenance.profileHash && /* @__PURE__ */ jsx("span", { className: "font-mono", children: item.provenance.profileHash.slice(0, 8) })
            ] })
          ] }),
          /* @__PURE__ */ jsx(StatePill, { state: item.state })
        ]
      }
    ) }, item.scopeKey)) }),
    cursor && /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        onClick: () => void load(cursor),
        disabled: loading,
        className: "w-full rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-accent disabled:opacity-50",
        children: "Load more"
      }
    )
  ] });
}
function locatorLabel(entry) {
  const parts = [];
  if (entry.locator.page !== void 0) parts.push(`p.${entry.locator.page}`);
  if (entry.locator.range) parts.push(entry.locator.range);
  return parts.length ? parts.join(" \xB7 ") : null;
}
function EvidenceLineageTable({ evidence, resolveSourceUrl, className }) {
  if (evidence.length === 0) {
    return /* @__PURE__ */ jsx("p", { className: `text-xs text-muted-foreground ${className ?? ""}`, children: "No evidence recorded." });
  }
  return /* @__PURE__ */ jsx("div", { className: `overflow-x-auto ${className ?? ""}`, children: /* @__PURE__ */ jsxs("table", { className: "w-full border-collapse text-left text-sm", children: [
    /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { className: "border-b border-border text-xs uppercase tracking-[0.05em] text-muted-foreground", children: [
      /* @__PURE__ */ jsx("th", { className: "py-1.5 pr-3 font-medium", children: "Target" }),
      /* @__PURE__ */ jsx("th", { className: "py-1.5 pr-3 font-medium", children: "Claim" }),
      /* @__PURE__ */ jsx("th", { className: "py-1.5 font-medium", children: "Source" })
    ] }) }),
    /* @__PURE__ */ jsx("tbody", { children: evidence.map((entry) => {
      const url = resolveSourceUrl?.(entry);
      const locator = locatorLabel(entry);
      return /* @__PURE__ */ jsxs("tr", { className: "border-b border-border align-top", children: [
        /* @__PURE__ */ jsx("td", { className: "py-2 pr-3 font-mono text-xs text-foreground", children: entry.target }),
        /* @__PURE__ */ jsxs("td", { className: "py-2 pr-3 text-sm leading-snug text-foreground", children: [
          entry.claim,
          entry.locator.quote && // The basis is what a reviewer weighs, so it has to be
          // visible per row, not only in the aggregate check detail.
          // A platform-sliced quote came out of the document's own
          // bytes; a model-typed one was proved to occur but was
          // transcribed. Same text, different strength of evidence.
          /* @__PURE__ */ jsxs(
            "span",
            {
              className: `mt-0.5 block border-l-2 pl-2 text-xs italic ${entry.locator.quoteBasis === "span" ? "border-primary/60 text-foreground" : "border-border text-muted-foreground"}`,
              title: entry.locator.quoteBasis === "span" ? "Sliced from the source document by the platform" : entry.locator.quoteBasis === "model" ? "Quoted by the agent, verified to occur in the source" : "Unverified quote",
              children: [
                "\u201C",
                entry.locator.quote,
                "\u201D",
                entry.locator.quoteBasis && /* @__PURE__ */ jsx("span", { className: "ml-1.5 align-middle text-xs not-italic uppercase tracking-[0.05em] text-muted-foreground", children: entry.locator.quoteBasis === "span" ? "from source" : "verified" })
              ]
            }
          )
        ] }),
        /* @__PURE__ */ jsxs("td", { className: "py-2 text-xs", children: [
          url ? /* @__PURE__ */ jsx(
            "a",
            {
              href: url,
              target: "_blank",
              rel: "noreferrer",
              className: "font-mono text-primary underline-offset-2 hover:underline",
              children: entry.sourceRef
            }
          ) : /* @__PURE__ */ jsx("span", { className: "font-mono text-muted-foreground", children: entry.sourceRef }),
          locator && /* @__PURE__ */ jsx("span", { className: "ml-1.5 text-muted-foreground", children: locator })
        ] })
      ] }, entry.id);
    }) })
  ] }) });
}
var SEVERITY_TONES = {
  blocking: "bg-destructive/10 text-destructive",
  material: "bg-warning/10 text-warning",
  advisory: "bg-secondary text-muted-foreground"
};
function ExceptionList({ exceptions, className }) {
  if (exceptions.length === 0) {
    return /* @__PURE__ */ jsx("p", { className: `text-xs text-muted-foreground ${className ?? ""}`, children: "No exceptions flagged." });
  }
  return /* @__PURE__ */ jsx("ul", { className: `space-y-1.5 ${className ?? ""}`, children: exceptions.map((entry) => /* @__PURE__ */ jsxs("li", { className: "flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2", children: [
    /* @__PURE__ */ jsx("span", { className: `mt-0.5 inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.05em] ${SEVERITY_TONES[entry.severity]}`, children: entry.severity }),
    /* @__PURE__ */ jsxs("div", { className: "min-w-0 flex-1", children: [
      /* @__PURE__ */ jsx("p", { className: `text-sm leading-snug ${entry.resolved ? "text-muted-foreground line-through" : "text-foreground"}`, children: entry.message }),
      /* @__PURE__ */ jsxs("p", { className: "mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground", children: [
        /* @__PURE__ */ jsx("span", { className: "font-mono", children: entry.kind }),
        entry.targets && entry.targets.length > 0 && /* @__PURE__ */ jsx("span", { className: "font-mono", children: entry.targets.join(", ") }),
        entry.resolved && /* @__PURE__ */ jsxs("span", { children: [
          "resolved",
          entry.resolvedBy ? ` by ${entry.resolvedBy}` : ""
        ] }),
        entry.resolutionNote && /* @__PURE__ */ jsx("span", { children: entry.resolutionNote })
      ] })
    ] })
  ] }, entry.id)) });
}
function QualityCheckList({ checks, className }) {
  if (checks.length === 0) {
    return /* @__PURE__ */ jsx("p", { className: `text-xs text-muted-foreground ${className ?? ""}`, children: "No checks recorded." });
  }
  return /* @__PURE__ */ jsx("ul", { className: `space-y-1 ${className ?? ""}`, children: checks.map((check) => /* @__PURE__ */ jsxs("li", { className: "flex items-start gap-2 rounded-md px-1 py-1", children: [
    check.passed ? /* @__PURE__ */ jsx("svg", { viewBox: "0 0 24 24", className: "mt-0.5 h-3.5 w-3.5 shrink-0 text-success", fill: "none", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx("polyline", { points: "20 6 9 17 4 12" }) }) : /* @__PURE__ */ jsxs("svg", { viewBox: "0 0 24 24", className: "mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive", fill: "none", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: [
      /* @__PURE__ */ jsx("line", { x1: "18", y1: "6", x2: "6", y2: "18" }),
      /* @__PURE__ */ jsx("line", { x1: "6", y1: "6", x2: "18", y2: "18" })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "min-w-0 flex-1", children: [
      /* @__PURE__ */ jsxs("p", { className: "text-sm text-foreground", children: [
        check.name,
        /* @__PURE__ */ jsx("span", { className: "ml-1.5 text-xs uppercase tracking-[0.05em] text-muted-foreground", children: check.source })
      ] }),
      check.detail && /* @__PURE__ */ jsx("p", { className: "text-xs leading-snug text-muted-foreground", children: check.detail })
    ] })
  ] }, check.id)) });
}
function truncateId(id, length) {
  return id.length > length ? `${id.slice(0, length)}\u2026` : id;
}
function ProvenanceStamp({ provenance, backtest, className }) {
  return /* @__PURE__ */ jsxs("div", { className: `flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground ${className ?? ""}`, children: [
    /* @__PURE__ */ jsxs("span", { className: "font-mono", title: provenance.profileHash, children: [
      "profile ",
      provenance.profileHash ? truncateId(provenance.profileHash, 10) : "\u2014"
    ] }),
    /* @__PURE__ */ jsxs("span", { className: "font-mono", title: provenance.runId, children: [
      "run ",
      provenance.runId ? truncateId(provenance.runId, 10) : "\u2014"
    ] }),
    provenance.servingModels.length > 0 ? provenance.servingModels.map((model) => /* @__PURE__ */ jsx("span", { className: "rounded-full bg-secondary px-2 py-0.5 font-mono", children: model }, model)) : /* @__PURE__ */ jsx("span", { className: "italic", children: "serving model pending" }),
    typeof provenance.costUsd === "number" && /* @__PURE__ */ jsxs("span", { children: [
      "$",
      provenance.costUsd.toFixed(provenance.costUsd < 0.01 ? 4 : 2)
    ] }),
    backtest && (backtest.trust === "pass" ? /* @__PURE__ */ jsxs("span", { className: "text-success", children: [
      backtest.cases,
      " backtest cases \xB7 composite ",
      backtest.composite.toFixed(2),
      " \xB7 trust PASS"
    ] }) : /* @__PURE__ */ jsx("span", { className: "text-warning", title: backtest.trustReasons.join("; "), children: "quality: unverified" }))
  ] });
}

export {
  reviewQueueStateLabel,
  workProductStatusLabel,
  workProductPartsFromMessageParts,
  WorkProductCard,
  mergeReviewQueuePages,
  ReviewQueuePanel,
  EvidenceLineageTable,
  ExceptionList,
  QualityCheckList,
  ProvenanceStamp
};
//# sourceMappingURL=chunk-ENLRJYVW.js.map