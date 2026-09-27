import {
  EvidenceLineageTable,
  ExceptionList,
  ProvenanceStamp,
  QualityCheckList,
  workProductStatusLabel
} from "../chunk-ENLRJYVW.js";
import "../chunk-GEYACSFW.js";
import {
  unresolvedBlockingExceptions
} from "../chunk-ZVEEWGDK.js";

// src/work-product-react/index.tsx
import { useCallback, useMemo, useState } from "react";
import {
  CodeSurface,
  DiffView,
  FileBreadcrumb,
  PillTabs
} from "@tangle-network/sandbox-ui/workbench";
import { jsx, jsxs } from "react/jsx-runtime";
function filenameOf(path, fallback) {
  if (!path) return fallback;
  const segments = path.split("/");
  return segments[segments.length - 1] || fallback;
}
function WorkProductPane({
  workProduct,
  defaultTab = "artifact",
  currentContent,
  baselineContent,
  loadVersionBody,
  resolveSourceUrl,
  backtest,
  className
}) {
  const artifact = workProduct.artifact;
  const body = currentContent ?? artifact?.content ?? "";
  const baseline = baselineContent ?? artifact?.baseline?.content;
  const hasDiff = baseline !== void 0;
  const tabs = useMemo(() => {
    const items = [{ value: "artifact", label: "Artifact" }];
    if (hasDiff) items.push({ value: "diff", label: "Diff" });
    items.push(
      { value: "lineage", label: `Lineage (${workProduct.evidence.length})` },
      { value: "exceptions", label: `Exceptions (${workProduct.exceptions.length})` },
      { value: "checks", label: `Checks (${workProduct.checks.length})` },
      { value: "history", label: `History (${workProduct.history.length})` }
    );
    return items;
  }, [hasDiff, workProduct.evidence.length, workProduct.exceptions.length, workProduct.checks.length, workProduct.history.length]);
  const initialTab = tabs.some((tab2) => tab2.value === defaultTab) ? defaultTab : "artifact";
  const [tab, setTab] = useState(initialTab);
  const [compare, setCompare] = useState(null);
  const [compareError, setCompareError] = useState(null);
  const diffFilename = filenameOf(artifact?.path, artifact?.title ?? workProduct.scopeKey);
  const loadCompare = useCallback(
    async (from, to) => {
      if (!loadVersionBody || !from.artifactPath || !to.artifactPath) return;
      setCompareError(null);
      try {
        const [fromBody, toBody] = await Promise.all([
          loadVersionBody(from.artifactPath),
          loadVersionBody(to.artifactPath)
        ]);
        if (fromBody === null || toBody === null) {
          setCompareError("A version snapshot could not be loaded.");
          return;
        }
        setCompare({ fromVersion: from.version, toVersion: to.version, baseline: fromBody, current: toBody });
      } catch (error) {
        setCompareError(error instanceof Error ? error.message : String(error));
      }
    },
    [loadVersionBody]
  );
  return /* @__PURE__ */ jsxs("div", { className: `flex min-h-0 flex-col gap-3 ${className ?? ""}`, children: [
    /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-3", children: [
      /* @__PURE__ */ jsxs("div", { className: "min-w-0 flex-1", children: [
        /* @__PURE__ */ jsxs("p", { className: "truncate text-sm font-semibold text-foreground", children: [
          artifact?.title ?? workProduct.scopeKey,
          /* @__PURE__ */ jsxs("span", { className: "ml-1.5 text-xs font-normal text-muted-foreground", children: [
            "v",
            workProduct.version
          ] })
        ] }),
        /* @__PURE__ */ jsxs("p", { className: "text-xs text-muted-foreground", children: [
          artifact?.kind && /* @__PURE__ */ jsxs("span", { className: "font-mono", children: [
            artifact.kind,
            " \xB7 "
          ] }),
          workProductStatusLabel(workProduct.status),
          unresolvedBlockingExceptions(workProduct.exceptions).length > 0 && /* @__PURE__ */ jsxs("span", { className: "text-destructive", children: [
            " \xB7 ",
            unresolvedBlockingExceptions(workProduct.exceptions).length,
            " blocking"
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsx(ProvenanceStamp, { provenance: workProduct.provenance, backtest })
    ] }),
    /* @__PURE__ */ jsx(PillTabs, { items: tabs, value: tab, onChange: setTab, "aria-label": "Work product views" }),
    tab === "artifact" && /* @__PURE__ */ jsxs("div", { className: "min-h-0 flex-1 overflow-auto rounded-lg border border-border", children: [
      artifact?.path && /* @__PURE__ */ jsx(FileBreadcrumb, { path: artifact.path, className: "border-b border-border px-3 py-2" }),
      body ? /* @__PURE__ */ jsx(CodeSurface, { code: body, filename: diffFilename }) : artifact?.fields ? /* @__PURE__ */ jsx(CodeSurface, { code: JSON.stringify(artifact.fields, null, 2), filename: `${diffFilename}.json`, language: "json" }) : /* @__PURE__ */ jsx("p", { className: "px-4 py-6 text-center text-xs text-muted-foreground", children: "No artifact body yet." })
    ] }),
    tab === "diff" && hasDiff && /* @__PURE__ */ jsx("div", { className: "min-h-0 flex-1 overflow-auto rounded-lg border border-border", children: /* @__PURE__ */ jsx(DiffView, { filename: diffFilename, baseline: baseline ?? "", current: body }) }),
    tab === "lineage" && /* @__PURE__ */ jsx(EvidenceLineageTable, { evidence: workProduct.evidence, resolveSourceUrl }),
    tab === "exceptions" && /* @__PURE__ */ jsx(ExceptionList, { exceptions: workProduct.exceptions }),
    tab === "checks" && /* @__PURE__ */ jsx(QualityCheckList, { checks: workProduct.checks }),
    tab === "history" && /* @__PURE__ */ jsxs("div", { className: "space-y-2", children: [
      workProduct.history.length === 0 && /* @__PURE__ */ jsx("p", { className: "text-xs text-muted-foreground", children: "No versions yet." }),
      workProduct.history.map((entry, index) => {
        const prior = workProduct.history.slice(0, index).reverse().find((candidate) => candidate.version < entry.version && candidate.artifactPath);
        return /* @__PURE__ */ jsxs("div", { className: "rounded-lg border border-border bg-card px-3 py-2", children: [
          /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [
            /* @__PURE__ */ jsxs("span", { className: "text-sm font-medium text-foreground", children: [
              "v",
              entry.version
            ] }),
            /* @__PURE__ */ jsx("span", { className: "text-xs text-muted-foreground", children: workProductStatusLabel(entry.status) }),
            entry.reviewedBy && /* @__PURE__ */ jsxs("span", { className: "text-xs text-muted-foreground", children: [
              "by ",
              entry.reviewedBy
            ] }),
            /* @__PURE__ */ jsx("span", { className: "flex-1" }),
            loadVersionBody && prior?.artifactPath && entry.artifactPath && /* @__PURE__ */ jsxs(
              "button",
              {
                type: "button",
                onClick: () => void loadCompare(prior, entry),
                className: "rounded-md border border-border px-2 py-0.5 text-xs font-medium text-foreground transition hover:bg-accent",
                children: [
                  "Compare v",
                  prior.version,
                  " \u2192 v",
                  entry.version
                ]
              }
            )
          ] }),
          entry.reviewNote && /* @__PURE__ */ jsx("p", { className: "mt-1 text-sm leading-snug text-foreground", children: entry.reviewNote }),
          /* @__PURE__ */ jsx(ProvenanceStamp, { provenance: entry.provenance, className: "mt-1" })
        ] }, `${entry.version}:${entry.status}:${entry.at}`);
      }),
      compareError && /* @__PURE__ */ jsx("p", { className: "rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive", children: compareError }),
      compare && /* @__PURE__ */ jsxs("div", { className: "overflow-auto rounded-lg border border-border", children: [
        /* @__PURE__ */ jsxs("p", { className: "border-b border-border px-3 py-2 text-xs text-muted-foreground", children: [
          "v",
          compare.fromVersion,
          " \u2192 v",
          compare.toVersion
        ] }),
        /* @__PURE__ */ jsx(DiffView, { filename: diffFilename, baseline: compare.baseline, current: compare.current })
      ] })
    ] })
  ] });
}
export {
  WorkProductPane
};
//# sourceMappingURL=index.js.map