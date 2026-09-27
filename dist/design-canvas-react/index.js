import {
  CanvasEmptyState,
  DesignCanvasEditor,
  ElementNode,
  GridLayer,
  SelectionLayer,
  Workspace,
  WorkspaceView,
  bakeLineTransform,
  bakeRectTransform,
  bakeTextTransform,
  downloadDataUrl,
  exportDocumentJson,
  exportPageDataUrl
} from "../chunk-G2B23BZ6.js";
import {
  BTN,
  BTN_ACTIVE,
  BTN_SM,
  BTN_SM_ACTIVE,
  DesignCanvas,
  EllipseGlyph,
  ExportControl,
  EyeGlyph,
  EyeOffGlyph,
  GroupGlyph,
  IconButton,
  ImageGlyph,
  LineGlyph,
  LockGlyph,
  PagesStrip,
  RectGlyph,
  Rulers,
  ShapesGlyph,
  SlotGlyph,
  TextGlyph,
  Toolbar,
  UnlockGlyph,
  VideoGlyph,
  ZoomControls,
  buildRulerTicks,
  formatRulerLabel,
  selectTickStep
} from "../chunk-KWN5PGXM.js";
import "../chunk-Q2QKEV6J.js";
import "../chunk-ZN5J47UX.js";
import {
  DEFAULT_INSERT_TEMPLATES,
  DUPLICATE_OFFSET,
  MAX_INSERT_DIMENSION,
  NODE_CACHE_PIXEL_RATIO_MAX,
  buildInsertImageOp,
  centeredPosition,
  collectGridTargets,
  createSnapEngine,
  createZoomPanMath,
  documentCropToStageCoords,
  fittedSize,
  hitTestPoint,
  identifyTaintedSrc,
  isCrossOriginSrc,
  isExportHiddenNodeName,
  marqueeSelect,
  mintElementId,
  nudgeDelta,
  resolveExportParams,
  resolveNodeCachePixelRatio
} from "../chunk-2WVBGQ2Y.js";
import {
  SCENE_COMMAND_HISTORY_LIMIT,
  addElementCommand,
  addPageCommand,
  bindSlotCommand,
  createSceneCommandStack,
  deleteElementCommand,
  deletePageCommand,
  duplicatePageCommand,
  groupElementsCommand,
  multiSetAttrsCommand,
  reorderElementCommand,
  reorderPageCommand,
  setAttrsCommand,
  setDocumentTitleCommand,
  setPageGuidesCommand,
  setPagePropsCommand,
  ungroupElementCommand
} from "../chunk-FEVVF6JJ.js";
import {
  DesignCanvasChromeLazy,
  DesignCanvasLazy
} from "../chunk-4S36HWE4.js";
import {
  assertSceneMediaSrc,
  bleedAwareExportBounds,
  scaleForPreset
} from "../chunk-BWQPVS7D.js";
import "../chunk-EA4UVS4T.js";
import "../chunk-TXD5HXLE.js";

// src/design-canvas-react/components/CanvasInsertPanel.tsx
import { useEffect, useRef, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
var DEFAULT_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
var PROBE_TIMEOUT_MS = 4e3;
function probeImageSize(url) {
  return new Promise((resolve) => {
    if (typeof Image === "undefined") return resolve({ width: 0, height: 0 });
    let settled = false;
    const finish = (size) => {
      if (settled) return;
      settled = true;
      resolve(size);
    };
    const img = new Image();
    img.onload = () => finish({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => finish({ width: 0, height: 0 });
    setTimeout(() => finish({ width: 0, height: 0 }), PROBE_TIMEOUT_MS);
    img.src = url;
  });
}
function UploadGlyph({ className }) {
  return /* @__PURE__ */ jsx("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx("path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 9l5-5 5 5M12 4v12" }) });
}
function SparkleGlyph({ className }) {
  return /* @__PURE__ */ jsx("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx("path", { d: "M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1M7.7 16.3l-2.1 2.1" }) });
}
function SpinnerGlyph({ className }) {
  return /* @__PURE__ */ jsx("svg", { className: `${className ?? ""} animate-spin`, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", "aria-hidden": true, children: /* @__PURE__ */ jsx("path", { d: "M21 12a9 9 0 1 1-6.2-8.6", strokeLinecap: "round" }) });
}
var PREVIEW_PROBE_PAGE = { pageId: "preview", width: 1e3, height: 1e3 };
var HEADING_FONT_SIZE = 32;
function templateShape(tpl) {
  try {
    const ops = tpl.build(PREVIEW_PROBE_PAGE);
    const added = ops.find((op) => op.type === "add_element");
    if (!added || added.type !== "add_element") return "other";
    const el = added.element;
    if (el.kind === "rect") return "rect";
    if (el.kind === "ellipse") return "ellipse";
    if (el.kind === "text") {
      const isHeading = el.fontStyle.includes("bold") || el.fontSize >= HEADING_FONT_SIZE;
      return isHeading ? "heading" : "body";
    }
    return "other";
  } catch {
    return "other";
  }
}
function TemplatePreview({ shape }) {
  if (shape === "rect") {
    return /* @__PURE__ */ jsx("span", { className: "block h-6 w-9 rounded-sm bg-[var(--brand-primary)]", "aria-hidden": true });
  }
  if (shape === "ellipse") {
    return /* @__PURE__ */ jsx("span", { className: "block h-7 w-7 rounded-full bg-[var(--brand-primary)]", "aria-hidden": true });
  }
  if (shape === "heading" || shape === "body") {
    return /* @__PURE__ */ jsx(
      "span",
      {
        className: `block leading-none text-[var(--text-primary)] ${shape === "heading" ? "text-2xl font-semibold" : "text-lg"}`,
        "aria-hidden": true,
        children: shape === "heading" ? "T" : "\xB6"
      }
    );
  }
  return /* @__PURE__ */ jsx(ShapesGlyph, { className: "h-6 w-6 text-[var(--text-muted)]" });
}
function CanvasInsertPanel({
  canWrite,
  page,
  onInsert,
  onUploadImage,
  loadGenerations,
  templates,
  accept = DEFAULT_ACCEPT,
  className
}) {
  const resolvedTemplates = templates ?? DEFAULT_INSERT_TEMPLATES;
  const templatesLabel = templates !== void 0 ? "Templates" : "Elements";
  const [tab, setTab] = useState(() => resolvedTemplates.length > 0 ? "templates" : "uploads");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [generations, setGenerations] = useState([]);
  const [generationsLoaded, setGenerationsLoaded] = useState(false);
  const fileInputRef = useRef(null);
  useEffect(() => {
    if (tab === "uploads" && !onUploadImage) {
      setTab(resolvedTemplates.length > 0 ? "templates" : loadGenerations ? "generations" : "uploads");
    }
    if (tab === "templates" && resolvedTemplates.length === 0) {
      setTab(onUploadImage ? "uploads" : loadGenerations ? "generations" : "uploads");
    }
    if (tab === "generations" && !loadGenerations) {
      setTab(resolvedTemplates.length > 0 ? "templates" : onUploadImage ? "uploads" : "templates");
    }
  }, [tab, resolvedTemplates.length, onUploadImage, loadGenerations]);
  useEffect(() => {
    if (tab !== "generations" || generationsLoaded || !loadGenerations) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await loadGenerations();
        if (!cancelled) setGenerations(rows.filter((g) => g.url));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load generations");
      } finally {
        if (!cancelled) setGenerationsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, generationsLoaded, loadGenerations]);
  async function insertImageFromUrl(url) {
    assertSceneMediaSrc(url, "image src");
    const natural = await probeImageSize(url);
    await onInsert([buildInsertImageOp(url, natural, page)]);
  }
  async function handleFiles(files) {
    if (!canWrite || busy) return;
    if (!onUploadImage) return;
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (list.length === 0) {
      setError("Only image files can be added to the canvas");
      return;
    }
    setBusy(true);
    setError("");
    try {
      for (const file of list) {
        const url = await onUploadImage(file);
        await insertImageFromUrl(url);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }
  async function runInsert(build) {
    if (!canWrite || busy) return;
    setBusy(true);
    setError("");
    try {
      await onInsert(await build());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Insert failed");
    } finally {
      setBusy(false);
    }
  }
  const tabs = [
    { id: "uploads", label: "Uploads", icon: ImageGlyph, show: !!onUploadImage },
    { id: "templates", label: templatesLabel, icon: ShapesGlyph, show: resolvedTemplates.length > 0 },
    { id: "generations", label: "Generations", icon: SparkleGlyph, show: !!loadGenerations }
  ];
  const visibleTabs = tabs.filter((t) => t.show);
  return /* @__PURE__ */ jsxs("div", { className: `flex h-full min-h-0 flex-col bg-[var(--bg-input)] text-[var(--text-primary)] ${className ?? ""}`, children: [
    /* @__PURE__ */ jsx("div", { className: "flex shrink-0 border-b border-[var(--border-default)]", children: visibleTabs.map(({ id, label, icon: Icon }) => /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        onClick: () => setTab(id),
        className: `flex flex-1 items-center justify-center gap-1.5 px-2 py-2.5 text-xs font-medium transition-colors focus-visible:[outline-offset:-2px] ${tab === id ? "border-b-2 border-[var(--brand-primary)] text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"}`,
        children: [
          /* @__PURE__ */ jsx(Icon, { className: "h-3.5 w-3.5" }),
          label
        ]
      },
      id
    )) }),
    !canWrite ? /* @__PURE__ */ jsx("div", { className: "flex flex-1 items-center justify-center p-4 text-center text-sm text-[var(--text-muted)]", children: "You have view-only access to this design." }) : /* @__PURE__ */ jsxs("div", { className: "min-h-0 flex-1 overflow-y-auto p-3", children: [
      tab === "uploads" && /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-3", children: [
        /* @__PURE__ */ jsxs(
          "button",
          {
            type: "button",
            disabled: busy,
            onClick: () => fileInputRef.current?.click(),
            onDragOver: (e) => {
              e.preventDefault();
              setDragOver(true);
            },
            onDragLeave: () => setDragOver(false),
            onDrop: (e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer?.files?.length) void handleFiles(e.dataTransfer.files);
            },
            className: `flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors disabled:opacity-50 ${dragOver ? "border-[var(--brand-primary)] bg-[color-mix(in_srgb,var(--brand-primary)_5%,transparent)]" : "border-[var(--border-default)] hover:border-[color-mix(in_srgb,var(--brand-primary)_40%,transparent)]"}`,
            children: [
              busy ? /* @__PURE__ */ jsx(SpinnerGlyph, { className: "h-6 w-6 text-[var(--brand-primary)]" }) : /* @__PURE__ */ jsx(UploadGlyph, { className: "h-6 w-6 text-[var(--text-muted)]" }),
              /* @__PURE__ */ jsx("span", { className: "text-sm font-medium text-[var(--text-primary)]", children: busy ? "Uploading\u2026" : "Drop an image or click to upload" }),
              /* @__PURE__ */ jsx("span", { className: "text-xs text-[var(--text-muted)]", children: "PNG, JPEG, GIF, or WebP" })
            ]
          }
        ),
        /* @__PURE__ */ jsx(
          "input",
          {
            ref: fileInputRef,
            type: "file",
            accept,
            multiple: true,
            className: "hidden",
            onChange: (e) => {
              if (e.target.files?.length) void handleFiles(e.target.files);
              e.target.value = "";
            }
          }
        )
      ] }),
      tab === "templates" && /* @__PURE__ */ jsx("div", { className: "grid grid-cols-2 gap-2", children: resolvedTemplates.map((tpl) => /* @__PURE__ */ jsxs(
        "button",
        {
          type: "button",
          disabled: busy,
          onClick: () => void runInsert(() => tpl.build(page)),
          className: "flex h-20 flex-col items-center justify-center gap-1.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-input)] text-xs font-medium text-[var(--text-primary)] transition-colors hover:border-[color-mix(in_srgb,var(--brand-primary)_40%,transparent)] disabled:opacity-50",
          children: [
            /* @__PURE__ */ jsx("span", { className: "flex h-7 items-center justify-center", children: /* @__PURE__ */ jsx(TemplatePreview, { shape: templateShape(tpl) }) }),
            /* @__PURE__ */ jsx("span", { children: tpl.label })
          ]
        },
        tpl.id
      )) }),
      tab === "generations" && /* @__PURE__ */ jsx("div", { className: "flex flex-col gap-2", children: !generationsLoaded ? /* @__PURE__ */ jsx("div", { className: "flex items-center justify-center py-8 text-[var(--text-muted)]", children: /* @__PURE__ */ jsx(SpinnerGlyph, { className: "h-5 w-5" }) }) : generations.length === 0 ? /* @__PURE__ */ jsx("p", { className: "px-1 py-6 text-center text-sm text-[var(--text-muted)]", children: "No generated images yet. Ask the agent to generate one." }) : /* @__PURE__ */ jsx("div", { className: "grid grid-cols-2 gap-2", children: generations.map((gen) => /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          disabled: busy,
          onClick: () => {
            if (busy || !canWrite) return;
            setBusy(true);
            setError("");
            insertImageFromUrl(gen.url).catch((err) => setError(err instanceof Error ? err.message : "Insert failed")).finally(() => setBusy(false));
          },
          title: gen.label,
          className: "group relative aspect-square overflow-hidden rounded-md border border-[var(--border-default)] bg-[var(--bg-input)] transition-colors hover:border-[var(--brand-primary)] disabled:opacity-50",
          children: /* @__PURE__ */ jsx("img", { src: gen.url, alt: gen.label || "Generated image", className: "h-full w-full object-cover" })
        },
        gen.id
      )) }) }),
      error ? /* @__PURE__ */ jsx("p", { className: "mt-3 text-xs leading-5 text-[var(--text-danger,#dc2626)]", children: error }) : null
    ] })
  ] });
}

// src/design-canvas-react/components/LayersPanel.tsx
import { useMemo, useRef as useRef2, useState as useState2 } from "react";

// src/design-canvas-react/components/layer-tree.ts
function flattenLayerTree(page) {
  const rows = [];
  function visit(elements, depth, parentGroupId) {
    for (let i = elements.length - 1; i >= 0; i -= 1) {
      const element = elements[i];
      rows.push({
        element,
        depth,
        isGroup: element.kind === "group",
        ownerIndex: i,
        ownerLength: elements.length,
        parentGroupId
      });
      if (element.kind === "group") {
        visit(element.children, depth + 1, element.id);
      }
    }
  }
  visit(page.elements, 0, null);
  return rows;
}
var LAYERS_PANEL_ROW_LIMIT = 500;

// src/design-canvas-react/components/LayersPanel.tsx
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
function KindIcon({ kind, className }) {
  switch (kind) {
    case "rect":
      return /* @__PURE__ */ jsx2(RectGlyph, { className });
    case "ellipse":
      return /* @__PURE__ */ jsx2(EllipseGlyph, { className });
    case "line":
      return /* @__PURE__ */ jsx2(LineGlyph, { className });
    case "text":
      return /* @__PURE__ */ jsx2(TextGlyph, { className });
    case "image":
      return /* @__PURE__ */ jsx2(ImageGlyph, { className });
    case "video":
      return /* @__PURE__ */ jsx2(VideoGlyph, { className });
    case "group":
      return /* @__PURE__ */ jsx2(GroupGlyph, { className });
  }
}
var INDENT_PX = 16;
function LayersPanel({ page, selectedElementIds, canWrite, onSetAttrs, onReorder, onSelect }) {
  const rows = useMemo(() => flattenLayerTree(page), [page]);
  const [renamingId, setRenamingId] = useState2(null);
  const [renameValue, setRenameValue] = useState2("");
  const dragRowRef = useRef2(null);
  const [dragOverIndex, setDragOverIndex] = useState2(null);
  function startRename(element) {
    setRenamingId(element.id);
    setRenameValue(element.name);
  }
  function commitRename(elementId) {
    const name = renameValue.trim();
    if (name.length > 0) onSetAttrs(elementId, { name });
    setRenamingId(null);
  }
  const visible = rows.length > LAYERS_PANEL_ROW_LIMIT ? rows.slice(0, LAYERS_PANEL_ROW_LIMIT) : rows;
  return /* @__PURE__ */ jsxs2("div", { className: "flex h-full flex-col overflow-hidden text-[var(--text-primary)]", children: [
    /* @__PURE__ */ jsx2("div", { className: "shrink-0 border-b border-[var(--border-default)] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.05em] text-[var(--text-muted)]", children: "Layers" }),
    /* @__PURE__ */ jsxs2("div", { className: "min-h-0 flex-1 overflow-y-auto", children: [
      visible.length === 0 ? /* @__PURE__ */ jsx2("div", { className: "px-3 py-2 text-xs text-[var(--text-muted)]", children: "No layers yet" }) : null,
      visible.map((row) => {
        const { element } = row;
        const isSelected = selectedElementIds.includes(element.id);
        const isRenaming = renamingId === element.id;
        return /* @__PURE__ */ jsxs2(
          "div",
          {
            "data-layer-row": element.id,
            draggable: canWrite,
            onDragStart: () => {
              dragRowRef.current = {
                elementId: element.id,
                ownerIndex: row.ownerIndex,
                ownerLength: row.ownerLength
              };
            },
            onDragOver: (event) => {
              if (!dragRowRef.current) return;
              event.preventDefault();
              setDragOverIndex(row.ownerIndex);
            },
            onDragLeave: () => setDragOverIndex(null),
            onDrop: () => {
              const drag = dragRowRef.current;
              if (!drag) return;
              if (drag.elementId !== element.id) {
                onReorder(drag.elementId, row.ownerIndex);
              }
              dragRowRef.current = null;
              setDragOverIndex(null);
            },
            onDragEnd: () => {
              dragRowRef.current = null;
              setDragOverIndex(null);
            },
            className: [
              "group flex items-center gap-1.5 py-1 pr-2 text-sm transition-colors",
              isSelected ? "bg-[color-mix(in_srgb,var(--brand-primary)_15%,transparent)] text-[var(--text-primary)]" : "hover:bg-[hsl(var(--accent))] text-[var(--text-secondary)]",
              dragOverIndex === row.ownerIndex ? "border-t border-[var(--brand-primary)]" : ""
            ].join(" "),
            style: { paddingLeft: 8 + row.depth * INDENT_PX },
            children: [
              isRenaming ? /* @__PURE__ */ jsx2(
                "input",
                {
                  autoFocus: true,
                  value: renameValue,
                  onChange: (event) => setRenameValue(event.target.value),
                  onBlur: () => commitRename(element.id),
                  onKeyDown: (event) => {
                    if (event.key === "Enter") commitRename(element.id);
                    if (event.key === "Escape") setRenamingId(null);
                    event.stopPropagation();
                  },
                  className: "min-w-0 flex-1 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-1 py-0 text-sm text-[var(--text-primary)] focus:border-[var(--brand-primary)]"
                }
              ) : (
                // Selection is a real button (sibling of the eye/lock buttons) so
                // the row is not an interactive control nesting interactive
                // controls (axe: nested-interactive).
                /* @__PURE__ */ jsxs2(
                  "button",
                  {
                    type: "button",
                    onClick: (event) => onSelect(element.id, event.metaKey || event.ctrlKey),
                    onDoubleClick: () => {
                      if (canWrite) startRename(element);
                    },
                    title: element.name,
                    className: "flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 bg-transparent text-left",
                    children: [
                      /* @__PURE__ */ jsx2(KindIcon, { kind: element.kind, className: "h-3.5 w-3.5 shrink-0 opacity-60" }),
                      element.slot ? /* @__PURE__ */ jsx2("span", { title: `Bound to slot: ${element.slot}`, className: "inline-flex shrink-0", children: /* @__PURE__ */ jsx2(SlotGlyph, { className: "h-3 w-3 text-[var(--brand-primary)]" }) }) : null,
                      /* @__PURE__ */ jsx2("span", { className: "min-w-0 flex-1 truncate", children: element.name })
                    ]
                  }
                )
              ),
              /* @__PURE__ */ jsx2(
                "button",
                {
                  type: "button",
                  "aria-label": element.visible ? "Hide element" : "Show element",
                  "aria-pressed": !element.visible,
                  onClick: (event) => {
                    event.stopPropagation();
                    if (canWrite) onSetAttrs(element.id, { visible: !element.visible });
                  },
                  disabled: !canWrite,
                  className: [
                    "shrink-0 rounded p-0.5 transition-opacity group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100",
                    element.visible ? "opacity-0" : "opacity-100"
                  ].join(" "),
                  children: element.visible ? /* @__PURE__ */ jsx2(EyeGlyph, { className: "h-3.5 w-3.5" }) : /* @__PURE__ */ jsx2(EyeOffGlyph, { className: "h-3.5 w-3.5 text-[var(--text-muted)]" })
                }
              ),
              /* @__PURE__ */ jsx2(
                "button",
                {
                  type: "button",
                  "aria-label": element.locked ? "Unlock element" : "Lock element",
                  "aria-pressed": !!element.locked,
                  onClick: (event) => {
                    event.stopPropagation();
                    if (canWrite) onSetAttrs(element.id, { locked: !element.locked });
                  },
                  disabled: !canWrite,
                  className: [
                    "shrink-0 rounded p-0.5 transition-opacity group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100",
                    element.locked ? "opacity-100" : "opacity-0"
                  ].join(" "),
                  children: element.locked ? /* @__PURE__ */ jsx2(LockGlyph, { className: "h-3.5 w-3.5 text-[var(--text-warning)]" }) : /* @__PURE__ */ jsx2(UnlockGlyph, { className: "h-3.5 w-3.5" })
                }
              )
            ]
          },
          element.id
        );
      }),
      rows.length > LAYERS_PANEL_ROW_LIMIT ? /* @__PURE__ */ jsxs2("div", { className: "px-3 py-2 text-xs text-[var(--text-muted)]", children: [
        "+",
        rows.length - LAYERS_PANEL_ROW_LIMIT,
        " more elements \u2014 select a group to scope the list"
      ] }) : null
    ] })
  ] });
}
export {
  BTN,
  BTN_ACTIVE,
  BTN_SM,
  BTN_SM_ACTIVE,
  CanvasEmptyState,
  CanvasInsertPanel,
  DEFAULT_INSERT_TEMPLATES,
  DUPLICATE_OFFSET,
  DesignCanvas,
  DesignCanvasChromeLazy,
  DesignCanvasEditor,
  DesignCanvasLazy,
  ElementNode,
  ExportControl,
  GridLayer,
  IconButton,
  LAYERS_PANEL_ROW_LIMIT,
  LayersPanel,
  MAX_INSERT_DIMENSION,
  NODE_CACHE_PIXEL_RATIO_MAX,
  PagesStrip,
  Rulers,
  SCENE_COMMAND_HISTORY_LIMIT,
  SelectionLayer,
  Toolbar,
  Workspace,
  WorkspaceView,
  ZoomControls,
  addElementCommand,
  addPageCommand,
  bakeLineTransform,
  bakeRectTransform,
  bakeTextTransform,
  bindSlotCommand,
  bleedAwareExportBounds,
  buildInsertImageOp,
  buildRulerTicks,
  centeredPosition,
  collectGridTargets,
  createSceneCommandStack,
  createSnapEngine,
  createZoomPanMath,
  deleteElementCommand,
  deletePageCommand,
  documentCropToStageCoords,
  downloadDataUrl,
  duplicatePageCommand,
  exportDocumentJson,
  exportPageDataUrl,
  fittedSize,
  flattenLayerTree,
  formatRulerLabel,
  groupElementsCommand,
  hitTestPoint,
  identifyTaintedSrc,
  isCrossOriginSrc,
  isExportHiddenNodeName,
  marqueeSelect,
  mintElementId,
  multiSetAttrsCommand,
  nudgeDelta,
  reorderElementCommand,
  reorderPageCommand,
  resolveExportParams,
  resolveNodeCachePixelRatio,
  scaleForPreset,
  selectTickStep,
  setAttrsCommand,
  setDocumentTitleCommand,
  setPageGuidesCommand,
  setPagePropsCommand,
  ungroupElementCommand
};
//# sourceMappingURL=index.js.map