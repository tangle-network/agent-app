import {
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
  setPageGuidesCommand,
  setPagePropsCommand,
  ungroupElementCommand
} from "./chunk-FEVVF6JJ.js";
import {
  SIZE_PRESETS,
  findElement,
  matchPreset,
  requirePage
} from "./chunk-BWQPVS7D.js";

// src/design-canvas-react/components/DesignCanvas.tsx
import { useCallback as useCallback2, useEffect as useEffect3, useMemo, useRef as useRef5, useState as useState5, useSyncExternalStore } from "react";

// src/design-canvas-react/components/BrandKnot.tsx
import { lazy, Suspense } from "react";
import { jsx } from "react/jsx-runtime";
function MarkSpacer({ size = 24, className }) {
  return /* @__PURE__ */ jsx("span", { "aria-hidden": true, style: { display: "inline-block", width: size, height: size }, className });
}
var LazyKnot = lazy(async () => {
  try {
    const mod = await import("./brand/index.js");
    return { default: mod.TangleKnot };
  } catch {
    return { default: MarkSpacer };
  }
});
function BrandKnot({ size = 24, className }) {
  return /* @__PURE__ */ jsx(Suspense, { fallback: /* @__PURE__ */ jsx(MarkSpacer, { size, className }), children: /* @__PURE__ */ jsx(LazyKnot, { size, className }) });
}

// src/design-canvas-react/components/ruler-math.ts
var TICK_STEP_CANDIDATES_PX = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1e3, 2500, 5e3];
function selectTickStep(input) {
  if (!Number.isFinite(input.zoom) || input.zoom <= 0) {
    throw new Error(`zoom must be a positive finite number, got ${input.zoom}`);
  }
  const minMajor = input.minMajorSpacingPx ?? 40;
  const minMinor = input.minMinorSpacingPx ?? 8;
  let major = TICK_STEP_CANDIDATES_PX[TICK_STEP_CANDIDATES_PX.length - 1];
  for (const candidate of TICK_STEP_CANDIDATES_PX) {
    if (candidate * input.zoom >= minMajor) {
      major = candidate;
      break;
    }
  }
  while (major * input.zoom < minMajor) {
    major = major * 2;
  }
  const minor = major / 5;
  const drawMinor = minor * input.zoom >= minMinor;
  return { major, minor, drawMinor };
}
function buildRulerTicks(input) {
  if (input.documentLength <= 0) return [];
  const { major, minor, drawMinor } = input.step;
  const ticks = [];
  for (let pos = 0; pos <= input.documentLength; pos += major) {
    ticks.push({ position: pos, label: formatRulerLabel(pos) });
    if (!drawMinor) continue;
    for (let m = 1; m < 5; m += 1) {
      const minorPos = pos + m * minor;
      if (minorPos >= input.documentLength) break;
      ticks.push({ position: minorPos, label: null });
    }
  }
  return ticks;
}
function formatRulerLabel(value) {
  if (!Number.isFinite(value)) return "";
  if (Math.abs(value) >= 1e3) {
    const k = value / 1e3;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
function screenToDocumentPosition(input) {
  if (!Number.isFinite(input.zoom) || input.zoom <= 0) {
    throw new Error(`zoom must be a positive finite number, got ${input.zoom}`);
  }
  return input.pointerScreenPx / input.zoom + input.scrollOffset;
}
function topIndex(ownerLength) {
  return ownerLength - 1;
}
function indexForward(current, ownerLength) {
  return Math.min(current + 1, ownerLength - 1);
}
function indexBackward(current) {
  return Math.max(current - 1, 0);
}
function clampIndex(target, ownerLength) {
  return Math.max(0, Math.min(target, ownerLength - 1));
}

// src/design-canvas-react/components/BleedTrimOverlay.tsx
import { Fragment, jsx as jsx2, jsxs } from "react/jsx-runtime";
var TRIM_MARK_PX = 12;
var TRIM_MARK_OFFSET_PX = 4;
function BleedTrimOverlay({ pageWidthPx, pageHeightPx, bleed }) {
  const totalW = bleed.left + pageWidthPx + bleed.right;
  const totalH = bleed.top + pageHeightPx + bleed.bottom;
  return /* @__PURE__ */ jsxs(
    "div",
    {
      "data-node": "overlay:bleed",
      className: "pointer-events-none absolute",
      style: {
        top: -bleed.top,
        left: -bleed.left,
        width: totalW,
        height: totalH
      },
      "aria-hidden": true,
      children: [
        /* @__PURE__ */ jsx2(
          "div",
          {
            className: "absolute bg-rose-500/10",
            style: { top: 0, left: 0, width: totalW, height: bleed.top }
          }
        ),
        /* @__PURE__ */ jsx2(
          "div",
          {
            className: "absolute bg-rose-500/10",
            style: { bottom: 0, left: 0, width: totalW, height: bleed.bottom }
          }
        ),
        /* @__PURE__ */ jsx2(
          "div",
          {
            className: "absolute bg-rose-500/10",
            style: { top: bleed.top, left: 0, width: bleed.left, height: pageHeightPx }
          }
        ),
        /* @__PURE__ */ jsx2(
          "div",
          {
            className: "absolute bg-rose-500/10",
            style: { top: bleed.top, right: 0, width: bleed.right, height: pageHeightPx }
          }
        ),
        /* @__PURE__ */ jsx2(TrimMark, { corner: "tl", bleed }),
        /* @__PURE__ */ jsx2(TrimMark, { corner: "tr", bleed, pageWidthPx }),
        /* @__PURE__ */ jsx2(TrimMark, { corner: "bl", bleed, pageHeightPx }),
        /* @__PURE__ */ jsx2(TrimMark, { corner: "br", bleed, pageWidthPx, pageHeightPx })
      ]
    }
  );
}
function TrimMark({ corner, bleed, pageWidthPx = 0, pageHeightPx = 0 }) {
  const isRight = corner === "tr" || corner === "br";
  const isBottom = corner === "bl" || corner === "br";
  const xBase = isRight ? bleed.left + pageWidthPx : bleed.left;
  const yBase = isBottom ? bleed.top + pageHeightPx : bleed.top;
  const hX = isRight ? xBase + TRIM_MARK_OFFSET_PX : xBase - TRIM_MARK_OFFSET_PX - TRIM_MARK_PX;
  const hY = yBase - 0.5;
  const vX = xBase - 0.5;
  const vY = isBottom ? yBase + TRIM_MARK_OFFSET_PX : yBase - TRIM_MARK_OFFSET_PX - TRIM_MARK_PX;
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx2(
      "div",
      {
        className: "absolute bg-[var(--text-muted)]",
        style: { left: hX, top: hY, width: TRIM_MARK_PX, height: 1 }
      }
    ),
    /* @__PURE__ */ jsx2(
      "div",
      {
        className: "absolute bg-[var(--text-muted)]",
        style: { left: vX, top: vY, width: 1, height: TRIM_MARK_PX }
      }
    )
  ] });
}

// src/design-canvas-react/components/PagesStrip.tsx
import { useEffect, useRef, useState } from "react";

// src/design-canvas-react/components/glyphs.tsx
import { Fragment as Fragment2, jsx as jsx3, jsxs as jsxs2 } from "react/jsx-runtime";
function glyph(paths) {
  return function Glyph({ className }) {
    return /* @__PURE__ */ jsx3(
      "svg",
      {
        className,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "2",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
        children: paths
      }
    );
  };
}
var UndoGlyph = glyph(/* @__PURE__ */ jsx3("path", { d: "M3 7v6h6M3 13a9 9 0 1 0 3-7.7" }));
var RedoGlyph = glyph(/* @__PURE__ */ jsx3("path", { d: "M21 7v6h-6M21 13a9 9 0 1 1-3-7.7" }));
var SwapGlyph = glyph(/* @__PURE__ */ jsx3("path", { d: "M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" }));
var EyeGlyph = glyph(
  /* @__PURE__ */ jsxs2(Fragment2, { children: [
    /* @__PURE__ */ jsx3("path", { d: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" }),
    /* @__PURE__ */ jsx3("circle", { cx: "12", cy: "12", r: "3" })
  ] })
);
var EyeOffGlyph = glyph(
  /* @__PURE__ */ jsxs2(Fragment2, { children: [
    /* @__PURE__ */ jsx3("path", { d: "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" }),
    /* @__PURE__ */ jsx3("path", { d: "M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" }),
    /* @__PURE__ */ jsx3("path", { d: "m1 1 22 22" })
  ] })
);
var LockGlyph = glyph(
  /* @__PURE__ */ jsxs2(Fragment2, { children: [
    /* @__PURE__ */ jsx3("rect", { x: "5", y: "11", width: "14", height: "10", rx: "2" }),
    /* @__PURE__ */ jsx3("path", { d: "M8 11V7a4 4 0 0 1 8 0v4" })
  ] })
);
var UnlockGlyph = glyph(
  /* @__PURE__ */ jsxs2(Fragment2, { children: [
    /* @__PURE__ */ jsx3("rect", { x: "5", y: "11", width: "14", height: "10", rx: "2" }),
    /* @__PURE__ */ jsx3("path", { d: "M8 11V7a4 4 0 1 1 8 0" })
  ] })
);
var TrashGlyph = glyph(
  /* @__PURE__ */ jsx3(Fragment2, { children: /* @__PURE__ */ jsx3("path", { d: "M3 6h18M19 6l-1 14H6L5 6M10 6V4h4v2" }) })
);
var GroupGlyph = glyph(
  /* @__PURE__ */ jsxs2(Fragment2, { children: [
    /* @__PURE__ */ jsx3("rect", { x: "2", y: "2", width: "8", height: "8", rx: "1" }),
    /* @__PURE__ */ jsx3("rect", { x: "14", y: "2", width: "8", height: "8", rx: "1" }),
    /* @__PURE__ */ jsx3("rect", { x: "2", y: "14", width: "8", height: "8", rx: "1" }),
    /* @__PURE__ */ jsx3("rect", { x: "14", y: "14", width: "8", height: "8", rx: "1" })
  ] })
);
var UngroupGlyph = glyph(
  /* @__PURE__ */ jsx3(Fragment2, { children: /* @__PURE__ */ jsx3("path", { d: "M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" }) })
);
var BringFrontGlyph = glyph(
  /* @__PURE__ */ jsxs2(Fragment2, { children: [
    /* @__PURE__ */ jsx3("rect", { x: "8", y: "8", width: "12", height: "12", rx: "1" }),
    /* @__PURE__ */ jsx3("path", { d: "M4 4h12v4H4z", opacity: ".4" })
  ] })
);
var SendBackGlyph = glyph(
  /* @__PURE__ */ jsxs2(Fragment2, { children: [
    /* @__PURE__ */ jsx3("rect", { x: "4", y: "4", width: "12", height: "12", rx: "1", opacity: ".4" }),
    /* @__PURE__ */ jsx3("path", { d: "M8 8h12v12H8z" })
  ] })
);
var AlignLeftGlyph = glyph(
  /* @__PURE__ */ jsx3(Fragment2, { children: /* @__PURE__ */ jsx3("path", { d: "M3 4v16M7 8h10M7 16h6" }) })
);
var AlignCenterGlyph = glyph(
  /* @__PURE__ */ jsx3(Fragment2, { children: /* @__PURE__ */ jsx3("path", { d: "M12 4v16M7 8h10M9 16h6" }) })
);
var AlignRightGlyph = glyph(
  /* @__PURE__ */ jsx3(Fragment2, { children: /* @__PURE__ */ jsx3("path", { d: "M21 4v16M7 8h10M11 16h6" }) })
);
var BoldGlyph = glyph(/* @__PURE__ */ jsx3("path", { d: "M6 4h8a4 4 0 0 1 0 8H6zM6 12h9a4 4 0 0 1 0 8H6z", fill: "currentColor", stroke: "none" }));
var ItalicGlyph = glyph(/* @__PURE__ */ jsx3("path", { d: "M11 4h6M7 20h6M14 4 8 20" }));
var PlusGlyph = glyph(/* @__PURE__ */ jsx3("path", { d: "M12 5v14M5 12h14" }));
var MinusGlyph = glyph(/* @__PURE__ */ jsx3("path", { d: "M5 12h14" }));
var ChevronDownGlyph = glyph(/* @__PURE__ */ jsx3("path", { d: "m6 9 6 6 6-6" }));
var RectGlyph = glyph(/* @__PURE__ */ jsx3("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }));
var EllipseGlyph = glyph(/* @__PURE__ */ jsx3("ellipse", { cx: "12", cy: "12", rx: "10", ry: "7" }));
var LineGlyph = glyph(/* @__PURE__ */ jsx3("path", { d: "M5 19 19 5" }));
var TextGlyph = glyph(/* @__PURE__ */ jsx3("path", { d: "M4 7V4h16v3M9 20h6M12 4v16" }));
var ImageGlyph = glyph(
  /* @__PURE__ */ jsxs2(Fragment2, { children: [
    /* @__PURE__ */ jsx3("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }),
    /* @__PURE__ */ jsx3("circle", { cx: "9", cy: "9", r: "2" }),
    /* @__PURE__ */ jsx3("path", { d: "m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" })
  ] })
);
var VideoGlyph = glyph(
  /* @__PURE__ */ jsxs2(Fragment2, { children: [
    /* @__PURE__ */ jsx3("rect", { x: "2", y: "3", width: "20", height: "18", rx: "2" }),
    /* @__PURE__ */ jsx3("path", { d: "m10 8 6 4-6 4z", fill: "currentColor", stroke: "none" })
  ] })
);
var SlotGlyph = glyph(
  /* @__PURE__ */ jsxs2(Fragment2, { children: [
    /* @__PURE__ */ jsx3("path", { d: "M3 4h6.5l2.5 3.5L14.5 4H21v16H3z" }),
    /* @__PURE__ */ jsx3("circle", { cx: "12", cy: "14", r: "2" })
  ] })
);
var PageGlyph = glyph(
  /* @__PURE__ */ jsxs2(Fragment2, { children: [
    /* @__PURE__ */ jsx3("path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" }),
    /* @__PURE__ */ jsx3("polyline", { points: "14 2 14 8 20 8" })
  ] })
);
var GridGlyph = glyph(
  /* @__PURE__ */ jsx3(Fragment2, { children: /* @__PURE__ */ jsx3("path", { d: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18" }) })
);
var RulerGlyph = glyph(
  /* @__PURE__ */ jsxs2(Fragment2, { children: [
    /* @__PURE__ */ jsx3("path", { d: "M1 9v6l12 6V9L1 3z" }),
    /* @__PURE__ */ jsx3("path", { d: "m13 15 9-4.5V4.5L13 9" }),
    /* @__PURE__ */ jsx3("path", { d: "M5 12v3M8 13.5v2.5M11 15v3" })
  ] })
);
var MagnetGlyph = glyph(
  /* @__PURE__ */ jsxs2(Fragment2, { children: [
    /* @__PURE__ */ jsx3("path", { d: "m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3z" }),
    /* @__PURE__ */ jsx3("path", { d: "m5 8 4 4M12 15l4 4" })
  ] })
);
var BleedGlyph = glyph(
  /* @__PURE__ */ jsxs2(Fragment2, { children: [
    /* @__PURE__ */ jsx3("rect", { x: "4", y: "4", width: "16", height: "16", strokeDasharray: "3 2" }),
    /* @__PURE__ */ jsx3("rect", { x: "7", y: "7", width: "10", height: "10" })
  ] })
);
var DuplicateGlyph = glyph(
  /* @__PURE__ */ jsxs2(Fragment2, { children: [
    /* @__PURE__ */ jsx3("rect", { x: "8", y: "8", width: "12", height: "12", rx: "2" }),
    /* @__PURE__ */ jsx3("path", { d: "M4 16V4a2 2 0 0 1 2-2h12" })
  ] })
);
var ZoomFitGlyph = glyph(
  /* @__PURE__ */ jsx3(Fragment2, { children: /* @__PURE__ */ jsx3("path", { d: "M15 3h6v6M14 10l6.1-6.1M9 21H3v-6M10 14l-6.1 6.1" }) })
);
var ExportGlyph = glyph(
  /* @__PURE__ */ jsx3(Fragment2, { children: /* @__PURE__ */ jsx3("path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" }) })
);
var ShapesGlyph = glyph(
  /* @__PURE__ */ jsxs2(Fragment2, { children: [
    /* @__PURE__ */ jsx3("rect", { x: "3", y: "13", width: "8", height: "8", rx: "1" }),
    /* @__PURE__ */ jsx3("circle", { cx: "17", cy: "17", r: "4" }),
    /* @__PURE__ */ jsx3("path", { d: "M8.5 3 13 11H4z" })
  ] })
);

// src/design-canvas-react/components/icon-button.tsx
import { forwardRef } from "react";
import { jsx as jsx4 } from "react/jsx-runtime";
var BTN_BASE = "items-center justify-center rounded border border-[var(--border-default)] text-[var(--text-secondary)] transition hover:text-[var(--text-primary)] disabled:cursor-default disabled:opacity-40";
var BTN_ACTIVE_EXTRA = " border-[var(--brand-primary)] text-[var(--brand-primary)] hover:text-[var(--brand-primary)]";
var BTN = `flex h-7 w-7 ${BTN_BASE}`;
var BTN_ACTIVE = BTN + BTN_ACTIVE_EXTRA;
var BTN_SM = `flex h-6 w-6 ${BTN_BASE}`;
var BTN_SM_ACTIVE = BTN_SM + BTN_ACTIVE_EXTRA;
var IconButton = forwardRef(function IconButton2({ active = false, size = "md", className = "", type = "button", ...rest }, ref) {
  const base = size === "sm" ? active ? BTN_SM_ACTIVE : BTN_SM : active ? BTN_ACTIVE : BTN;
  return /* @__PURE__ */ jsx4("button", { ref, type, className: className ? `${base} ${className}` : base, ...rest });
});

// src/design-canvas-react/components/PagesStrip.tsx
import { jsx as jsx5, jsxs as jsxs3 } from "react/jsx-runtime";
var THUMBNAIL_W = 80;
var THUMBNAIL_H = 56;
function PagesStrip({
  pages,
  activePageId,
  canWrite,
  renderThumbnail,
  onSelectPage,
  onAddPage,
  onDuplicatePage,
  onDeletePage,
  onReorderPage,
  canManagePages = true,
  label = "Pages"
}) {
  const [thumbnails, setThumbnails] = useState({});
  const thumbnailVersionRef = useRef(0);
  useEffect(() => {
    const version = ++thumbnailVersionRef.current;
    let cancelled = false;
    async function generate() {
      const results = {};
      for (const page of pages) {
        if (cancelled) return;
        try {
          results[page.id] = await renderThumbnail(page);
        } catch {
          results[page.id] = null;
        }
      }
      if (!cancelled && thumbnailVersionRef.current === version) {
        setThumbnails(results);
      }
    }
    void generate();
    return () => {
      cancelled = true;
    };
  }, [pages]);
  const dragIndexRef = useRef(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  return /* @__PURE__ */ jsxs3("div", { className: "flex shrink-0 flex-col bg-[var(--bg-input)]", children: [
    label ? /* @__PURE__ */ jsxs3("div", { className: "flex items-center gap-1.5 px-3 pt-1.5 text-[var(--text-muted)]", children: [
      /* @__PURE__ */ jsx5(PageGlyph, { className: "h-3 w-3" }),
      /* @__PURE__ */ jsx5("span", { className: "text-xs font-semibold uppercase tracking-[0.05em]", children: label })
    ] }) : null,
    /* @__PURE__ */ jsxs3(
      "div",
      {
        className: "flex h-[92px] items-center gap-2 overflow-x-auto px-2 pb-2 pt-2",
        "aria-label": "Pages",
        children: [
          pages.map((page, index) => {
            const isActive = page.id === activePageId;
            const thumbUrl = thumbnails[page.id];
            return /* @__PURE__ */ jsxs3(
              "div",
              {
                draggable: canWrite,
                onDragStart: () => {
                  dragIndexRef.current = index;
                },
                onDragOver: (event) => {
                  if (dragIndexRef.current === null) return;
                  event.preventDefault();
                  setDragOverIndex(index);
                },
                onDragLeave: () => setDragOverIndex(null),
                onDrop: () => {
                  const from = dragIndexRef.current;
                  if (from !== null && from !== index) {
                    onReorderPage(pages[from].id, index);
                  }
                  dragIndexRef.current = null;
                  setDragOverIndex(null);
                },
                onDragEnd: () => {
                  dragIndexRef.current = null;
                  setDragOverIndex(null);
                },
                className: [
                  "group relative flex shrink-0 flex-col items-center gap-1 rounded p-1 transition",
                  isActive ? "ring-2 ring-[var(--brand-primary)]" : "hover:bg-[hsl(var(--accent))]",
                  dragOverIndex === index ? "ring-1 ring-[color-mix(in_srgb,var(--brand-primary)_60%,transparent)]" : ""
                ].join(" "),
                children: [
                  /* @__PURE__ */ jsxs3(
                    "button",
                    {
                      type: "button",
                      "aria-label": `Page ${index + 1}: ${page.name}${isActive ? " (active)" : ""}`,
                      "aria-pressed": isActive,
                      onClick: () => onSelectPage(page.id),
                      className: "flex cursor-pointer flex-col items-center gap-1 rounded",
                      children: [
                        /* @__PURE__ */ jsx5(
                          "div",
                          {
                            className: "overflow-hidden rounded border border-[var(--border-default)] bg-[hsl(var(--card))]",
                            style: { width: THUMBNAIL_W, height: THUMBNAIL_H },
                            children: thumbUrl ? /* @__PURE__ */ jsx5(
                              "img",
                              {
                                src: thumbUrl,
                                alt: page.name,
                                className: "h-full w-full object-contain",
                                draggable: false
                              }
                            ) : /* @__PURE__ */ jsx5("div", { className: "flex h-full w-full items-center justify-center", children: /* @__PURE__ */ jsx5(PageGlyph, { className: "h-5 w-5 text-[var(--text-muted)]" }) })
                          }
                        ),
                        /* @__PURE__ */ jsx5("span", { className: "max-w-[80px] truncate text-xs text-[var(--text-secondary)]", children: page.name })
                      ]
                    }
                  ),
                  canWrite && canManagePages ? /* @__PURE__ */ jsxs3("div", { className: "pointer-events-none absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100", children: [
                    /* @__PURE__ */ jsx5(
                      "button",
                      {
                        type: "button",
                        "aria-label": `Duplicate page ${page.name}`,
                        onClick: (event) => {
                          event.stopPropagation();
                          onDuplicatePage(page.id);
                        },
                        className: BTN_SM,
                        children: /* @__PURE__ */ jsx5(DuplicateGlyph, { className: "h-3 w-3" })
                      }
                    ),
                    /* @__PURE__ */ jsx5(
                      "button",
                      {
                        type: "button",
                        "aria-label": `Delete page ${page.name}`,
                        disabled: pages.length <= 1,
                        onClick: (event) => {
                          event.stopPropagation();
                          if (pages.length > 1) onDeletePage(page.id);
                        },
                        className: BTN_SM,
                        children: /* @__PURE__ */ jsx5(TrashGlyph, { className: "h-3 w-3 text-[var(--text-danger)]" })
                      }
                    )
                  ] }) : null
                ]
              },
              page.id
            );
          }),
          canWrite && canManagePages ? /* @__PURE__ */ jsxs3(
            "button",
            {
              type: "button",
              "aria-label": "Add page",
              onClick: onAddPage,
              className: "flex h-[72px] w-[80px] shrink-0 flex-col items-center justify-center gap-1 rounded border border-dashed border-[var(--border-default)] text-[var(--text-muted)] transition hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)]",
              children: [
                /* @__PURE__ */ jsx5(PlusGlyph, { className: "h-4 w-4" }),
                /* @__PURE__ */ jsx5("span", { className: "text-xs", children: "Add page" })
              ]
            }
          ) : null
        ]
      }
    )
  ] });
}

// src/design-canvas-react/components/Rulers.tsx
import { useRef as useRef2, useState as useState2 } from "react";
import { Fragment as Fragment3, jsx as jsx6, jsxs as jsxs4 } from "react/jsx-runtime";
var RULER_SIZE_PX = 20;
var DELETE_THRESHOLD_PX = RULER_SIZE_PX + 4;
function Rulers({ pageWidth, pageHeight, zoom, scrollLeft, scrollTop, showRulers, guides, onGuidesChange }) {
  if (!showRulers) return null;
  return /* @__PURE__ */ jsxs4(Fragment3, { children: [
    /* @__PURE__ */ jsx6(
      "div",
      {
        className: "absolute top-0 left-0 z-20 shrink-0 border-b border-r border-[var(--border-default)] bg-[var(--bg-input)]",
        style: { width: RULER_SIZE_PX, height: RULER_SIZE_PX }
      }
    ),
    /* @__PURE__ */ jsx6(
      HorizontalRuler,
      {
        pageWidth,
        zoom,
        scrollLeft,
        guides,
        onGuidesChange
      }
    ),
    /* @__PURE__ */ jsx6(
      VerticalRuler,
      {
        pageHeight,
        zoom,
        scrollTop,
        guides,
        onGuidesChange
      }
    ),
    /* @__PURE__ */ jsx6(GuidesCanvasOverlay, { guides, zoom, scrollLeft, scrollTop })
  ] });
}
function HorizontalRuler({ pageWidth, zoom, scrollLeft, guides, onGuidesChange }) {
  const ref = useRef2(null);
  const [pointerX, setPointerX] = useState2(null);
  const [dragGuideX, setDragGuideX] = useState2(null);
  const dragGuideIndexRef = useRef2(null);
  const step = selectTickStep({ zoom, minMajorSpacingPx: 40 });
  const ticks = buildRulerTicks({ documentLength: pageWidth, step });
  function screenXToDoc(clientX) {
    if (!ref.current) return 0;
    const rect = ref.current.getBoundingClientRect();
    return screenToDocumentPosition({ pointerScreenPx: clientX - rect.left, scrollOffset: scrollLeft, zoom });
  }
  function handlePointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const docX = screenXToDoc(event.clientX);
    const threshold = 4 / zoom;
    const nearIdx = guides.vertical.findIndex((g) => Math.abs(g - docX) <= threshold);
    if (nearIdx >= 0) {
      dragGuideIndexRef.current = nearIdx;
    } else {
      dragGuideIndexRef.current = null;
    }
    setDragGuideX(docX);
  }
  function handlePointerMove(event) {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const localY = event.clientY - rect.top;
    setPointerX(event.clientX - rect.left);
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const docX = screenXToDoc(event.clientX);
    if (localY > DELETE_THRESHOLD_PX) {
      setDragGuideX(docX);
    } else {
      setDragGuideX(null);
    }
  }
  function handlePointerUp(event) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const rect = ref.current?.getBoundingClientRect();
    const localY = rect ? event.clientY - rect.top : 0;
    const deletingExisting = dragGuideIndexRef.current !== null;
    const docX = screenXToDoc(event.clientX);
    const vertical = [...guides.vertical];
    if (localY <= DELETE_THRESHOLD_PX && deletingExisting) {
      vertical.splice(dragGuideIndexRef.current, 1);
    } else if (localY > DELETE_THRESHOLD_PX) {
      if (deletingExisting) {
        vertical[dragGuideIndexRef.current] = docX;
      } else {
        vertical.push(docX);
      }
    }
    dragGuideIndexRef.current = null;
    setDragGuideX(null);
    onGuidesChange({ ...guides, vertical });
  }
  function handlePointerLeave() {
    setPointerX(null);
  }
  return /* @__PURE__ */ jsxs4(
    "div",
    {
      ref,
      className: "absolute top-0 left-0 right-0 z-10 cursor-ew-resize select-none overflow-hidden border-b border-[var(--border-default)] bg-[var(--bg-input)]",
      style: { height: RULER_SIZE_PX, marginLeft: RULER_SIZE_PX },
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerLeave: handlePointerLeave,
      children: [
        ticks.map((tick) => {
          const screenX = tick.position * zoom - scrollLeft * zoom;
          return /* @__PURE__ */ jsx6(
            "div",
            {
              className: `absolute bottom-0 w-px bg-[var(--border-default)] ${tick.label !== null ? "top-1.5" : "top-[14px]"}`,
              style: { left: screenX },
              children: tick.label !== null ? /* @__PURE__ */ jsx6("span", { className: "absolute -top-1 left-0.5 whitespace-nowrap font-mono text-[9px] leading-none text-[var(--text-muted)]", children: tick.label }) : null
            },
            tick.position
          );
        }),
        guides.vertical.map((position, index) => /* @__PURE__ */ jsx6(
          "div",
          {
            "data-guide-marker": "vertical",
            "aria-hidden": true,
            className: "pointer-events-none absolute top-0 bottom-0 w-px bg-[var(--brand-primary)]",
            style: { left: position * zoom - scrollLeft * zoom }
          },
          `guide-${index}`
        )),
        pointerX !== null ? /* @__PURE__ */ jsx6(
          "div",
          {
            className: "pointer-events-none absolute top-0 bottom-0 w-px bg-[color-mix(in_srgb,var(--brand-primary)_60%,transparent)]",
            style: { left: pointerX }
          }
        ) : null,
        dragGuideX !== null ? /* @__PURE__ */ jsx6(
          "div",
          {
            className: "pointer-events-none absolute top-0 bottom-0 w-px bg-[var(--brand-primary)]",
            style: { left: dragGuideX * zoom - scrollLeft * zoom }
          }
        ) : null
      ]
    }
  );
}
function VerticalRuler({ pageHeight, zoom, scrollTop, guides, onGuidesChange }) {
  const ref = useRef2(null);
  const [pointerY, setPointerY] = useState2(null);
  const [dragGuideY, setDragGuideY] = useState2(null);
  const dragGuideIndexRef = useRef2(null);
  const step = selectTickStep({ zoom, minMajorSpacingPx: 40 });
  const ticks = buildRulerTicks({ documentLength: pageHeight, step });
  function screenYToDoc(clientY) {
    if (!ref.current) return 0;
    const rect = ref.current.getBoundingClientRect();
    return screenToDocumentPosition({ pointerScreenPx: clientY - rect.top, scrollOffset: scrollTop, zoom });
  }
  function handlePointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const docY = screenYToDoc(event.clientY);
    const threshold = 4 / zoom;
    const nearIdx = guides.horizontal.findIndex((g) => Math.abs(g - docY) <= threshold);
    dragGuideIndexRef.current = nearIdx >= 0 ? nearIdx : null;
    setDragGuideY(docY);
  }
  function handlePointerMove(event) {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    setPointerY(event.clientY - rect.top);
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const docY = screenYToDoc(event.clientY);
    if (localX > DELETE_THRESHOLD_PX) {
      setDragGuideY(docY);
    } else {
      setDragGuideY(null);
    }
  }
  function handlePointerUp(event) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const rect = ref.current?.getBoundingClientRect();
    const localX = rect ? event.clientX - rect.left : 0;
    const deletingExisting = dragGuideIndexRef.current !== null;
    const docY = screenYToDoc(event.clientY);
    const horizontal = [...guides.horizontal];
    if (localX <= DELETE_THRESHOLD_PX && deletingExisting) {
      horizontal.splice(dragGuideIndexRef.current, 1);
    } else if (localX > DELETE_THRESHOLD_PX) {
      if (deletingExisting) {
        horizontal[dragGuideIndexRef.current] = docY;
      } else {
        horizontal.push(docY);
      }
    }
    dragGuideIndexRef.current = null;
    setDragGuideY(null);
    onGuidesChange({ ...guides, horizontal });
  }
  function handlePointerLeave() {
    setPointerY(null);
  }
  return /* @__PURE__ */ jsxs4(
    "div",
    {
      ref,
      className: "absolute top-0 left-0 bottom-0 z-10 cursor-ns-resize select-none overflow-hidden border-r border-[var(--border-default)] bg-[var(--bg-input)]",
      style: { width: RULER_SIZE_PX, marginTop: RULER_SIZE_PX },
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerLeave: handlePointerLeave,
      children: [
        ticks.map((tick) => {
          const screenY = tick.position * zoom - scrollTop * zoom;
          return /* @__PURE__ */ jsx6(
            "div",
            {
              className: `absolute right-0 h-px bg-[var(--border-default)] ${tick.label !== null ? "left-1.5" : "left-[14px]"}`,
              style: { top: screenY },
              children: tick.label !== null ? /* @__PURE__ */ jsx6(
                "span",
                {
                  className: "absolute top-0.5 left-0 whitespace-nowrap font-mono text-[9px] leading-none text-[var(--text-muted)]",
                  style: { transform: "rotate(-90deg)", transformOrigin: "0 0", marginTop: 4 },
                  children: tick.label
                }
              ) : null
            },
            tick.position
          );
        }),
        guides.horizontal.map((position, index) => /* @__PURE__ */ jsx6(
          "div",
          {
            "data-guide-marker": "horizontal",
            "aria-hidden": true,
            className: "pointer-events-none absolute left-0 right-0 h-px bg-[var(--brand-primary)]",
            style: { top: position * zoom - scrollTop * zoom }
          },
          `guide-${index}`
        )),
        pointerY !== null ? /* @__PURE__ */ jsx6(
          "div",
          {
            className: "pointer-events-none absolute left-0 right-0 h-px bg-[color-mix(in_srgb,var(--brand-primary)_60%,transparent)]",
            style: { top: pointerY }
          }
        ) : null,
        dragGuideY !== null ? /* @__PURE__ */ jsx6(
          "div",
          {
            className: "pointer-events-none absolute left-0 right-0 h-px bg-[var(--brand-primary)]",
            style: { top: dragGuideY * zoom - scrollTop * zoom }
          }
        ) : null
      ]
    }
  );
}
function GuidesCanvasOverlay({ guides, zoom, scrollLeft, scrollTop }) {
  if (guides.vertical.length === 0 && guides.horizontal.length === 0) return null;
  return /* @__PURE__ */ jsxs4(
    "div",
    {
      "aria-hidden": true,
      className: "pointer-events-none absolute right-0 bottom-0 z-10 overflow-hidden",
      style: { left: RULER_SIZE_PX, top: RULER_SIZE_PX },
      children: [
        guides.vertical.map((position, index) => /* @__PURE__ */ jsx6(
          "div",
          {
            "data-guide-line": "vertical",
            className: "absolute top-0 bottom-0 w-px bg-[var(--brand-primary)]",
            style: { left: position * zoom - scrollLeft * zoom }
          },
          `v-${index}`
        )),
        guides.horizontal.map((position, index) => /* @__PURE__ */ jsx6(
          "div",
          {
            "data-guide-line": "horizontal",
            className: "absolute left-0 right-0 h-px bg-[var(--brand-primary)]",
            style: { top: position * zoom - scrollTop * zoom }
          },
          `h-${index}`
        ))
      ]
    }
  );
}

// src/design-canvas-react/components/Toolbar.tsx
import { useEffect as useEffect2, useRef as useRef3, useState as useState3 } from "react";
import { Fragment as Fragment4, jsx as jsx7, jsxs as jsxs5 } from "react/jsx-runtime";
var FONT_FAMILIES = [
  "Inter",
  "Arial",
  "Helvetica",
  "Verdana",
  "Tahoma",
  "Trebuchet MS",
  "Times New Roman",
  "Georgia",
  "Garamond",
  "Courier New",
  "Brush Script MT",
  "Impact"
];
var SEP = /* @__PURE__ */ jsx7("div", { className: "mx-1 h-5 w-px shrink-0 bg-[var(--border-default)]" });
var POPOVER_PANEL = "absolute top-full left-0 z-50 mt-1 flex flex-col rounded border border-[var(--card-edge)] bg-[hsl(var(--popover))] shadow-[var(--shadow-overlay)]";
function Popover({
  open,
  onClose,
  trigger,
  children
}) {
  const ref = useRef3(null);
  useEffect2(() => {
    if (!open) return;
    function onDocPointer(event) {
      if (ref.current && !ref.current.contains(event.target)) onClose();
    }
    function onKey(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  return /* @__PURE__ */ jsxs5("div", { ref, className: "relative", children: [
    trigger,
    open ? children : null
  ] });
}
var FIELD_LABEL = "text-xs font-semibold uppercase tracking-[0.05em] text-[var(--text-muted)]";
function NumberInput({
  label,
  value,
  onCommit,
  min,
  step = 1,
  className = "w-16"
}) {
  const [raw, setRaw] = useState3(null);
  function commit(v) {
    const n = parseFloat(v);
    if (Number.isFinite(n) && (min === void 0 || n >= min)) onCommit(n);
    setRaw(null);
  }
  return /* @__PURE__ */ jsxs5("label", { className: "flex flex-col items-center gap-0.5", children: [
    /* @__PURE__ */ jsx7("span", { className: FIELD_LABEL, children: label }),
    /* @__PURE__ */ jsx7(
      "input",
      {
        type: "number",
        value: raw ?? value,
        min,
        step,
        onChange: (event) => setRaw(event.target.value),
        onBlur: (event) => commit(event.target.value),
        onKeyDown: (event) => {
          if (event.key === "Enter") commit(event.target.value);
          if (event.key === "Escape") setRaw(null);
        },
        className: `${className} rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-1 py-0.5 text-center text-xs text-[var(--text-primary)] focus:border-[var(--brand-primary)]`
      }
    )
  ] });
}
function SelectControl({
  label,
  value,
  options,
  disabled,
  onChange,
  buttonClassName = "w-24"
}) {
  const [open, setOpen] = useState3(false);
  const current = options.find((o) => o.value === value);
  return /* @__PURE__ */ jsxs5("label", { className: "flex flex-col items-center gap-0.5", children: [
    /* @__PURE__ */ jsx7("span", { className: FIELD_LABEL, children: label }),
    /* @__PURE__ */ jsx7(
      Popover,
      {
        open,
        onClose: () => setOpen(false),
        trigger: /* @__PURE__ */ jsxs5(
          "button",
          {
            type: "button",
            disabled,
            "aria-haspopup": "listbox",
            "aria-expanded": open,
            onClick: () => setOpen((v) => !v),
            className: `${buttonClassName} flex items-center justify-between gap-1 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-2 py-0.5 text-left text-xs text-[var(--text-primary)] hover:border-[var(--brand-primary)] disabled:cursor-default disabled:opacity-40`,
            children: [
              /* @__PURE__ */ jsx7("span", { className: "truncate", children: current?.label ?? value }),
              /* @__PURE__ */ jsx7(ChevronDownGlyph, { className: "h-3 w-3 shrink-0 text-[var(--text-muted)]" })
            ]
          }
        ),
        children: /* @__PURE__ */ jsx7("div", { role: "listbox", className: `${POPOVER_PANEL} max-h-64 w-44 overflow-y-auto py-1`, children: options.map((opt) => /* @__PURE__ */ jsx7(
          "button",
          {
            type: "button",
            role: "option",
            "aria-selected": opt.value === value,
            onClick: () => {
              onChange(opt.value);
              setOpen(false);
            },
            className: `px-3 py-1 text-left text-xs hover:bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] ${opt.value === value ? "text-[var(--brand-primary)]" : "text-[var(--text-primary)]"}`,
            children: opt.label
          },
          opt.value
        )) })
      }
    )
  ] });
}
function FontPicker({
  value,
  disabled,
  onChange
}) {
  const [open, setOpen] = useState3(false);
  const [query, setQuery] = useState3("");
  const families = FONT_FAMILIES.includes(value) ? [...FONT_FAMILIES] : [value, ...FONT_FAMILIES];
  const filtered = families.filter((f) => f.toLowerCase().includes(query.trim().toLowerCase()));
  return /* @__PURE__ */ jsxs5("label", { className: "flex flex-col items-center gap-0.5", children: [
    /* @__PURE__ */ jsx7("span", { className: FIELD_LABEL, children: "Font" }),
    /* @__PURE__ */ jsx7(
      Popover,
      {
        open,
        onClose: () => {
          setOpen(false);
          setQuery("");
        },
        trigger: /* @__PURE__ */ jsxs5(
          "button",
          {
            type: "button",
            disabled,
            "aria-haspopup": "listbox",
            "aria-expanded": open,
            "aria-label": "Font family",
            onClick: () => setOpen((v) => !v),
            className: "flex w-28 items-center justify-between gap-1 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-2 py-0.5 text-left text-xs text-[var(--text-primary)] hover:border-[var(--brand-primary)] disabled:cursor-default disabled:opacity-40",
            style: { fontFamily: value },
            children: [
              /* @__PURE__ */ jsx7("span", { className: "truncate", children: value }),
              /* @__PURE__ */ jsx7(ChevronDownGlyph, { className: "h-3 w-3 shrink-0 text-[var(--text-muted)]" })
            ]
          }
        ),
        children: /* @__PURE__ */ jsxs5("div", { className: `${POPOVER_PANEL} w-52`, children: [
          /* @__PURE__ */ jsx7(
            "input",
            {
              autoFocus: true,
              value: query,
              onChange: (event) => setQuery(event.target.value),
              placeholder: "Search fonts",
              "aria-label": "Search fonts",
              className: "m-1 rounded border border-[var(--border-default)] bg-transparent px-2 py-1 text-xs text-[var(--text-primary)] focus:border-[var(--brand-primary)]"
            }
          ),
          /* @__PURE__ */ jsx7("div", { role: "listbox", className: "max-h-60 overflow-y-auto py-1", children: filtered.length === 0 ? /* @__PURE__ */ jsx7("div", { className: "px-3 py-2 text-xs text-[var(--text-muted)]", children: "No matches" }) : filtered.map((family) => /* @__PURE__ */ jsx7(
            "button",
            {
              type: "button",
              role: "option",
              "aria-selected": family === value,
              onClick: () => {
                onChange(family);
                setOpen(false);
                setQuery("");
              },
              style: { fontFamily: family },
              className: `block w-full px-3 py-1 text-left text-sm hover:bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] ${family === value ? "text-[var(--brand-primary)]" : "text-[var(--text-primary)]"}`,
              children: family
            },
            family
          )) })
        ] })
      }
    )
  ] });
}
function ColorSwatch({ label, value, onCommit, disabled, none = false }) {
  const [open, setOpen] = useState3(false);
  const normalized = value.startsWith("#") ? value : "#ffffff";
  return /* @__PURE__ */ jsxs5("div", { className: "flex flex-col items-center gap-0.5", children: [
    /* @__PURE__ */ jsx7("span", { className: FIELD_LABEL, children: label }),
    /* @__PURE__ */ jsx7(
      Popover,
      {
        open,
        onClose: () => setOpen(false),
        trigger: /* @__PURE__ */ jsx7(
          "button",
          {
            type: "button",
            disabled,
            "aria-label": none ? `${label} color (none)` : `${label} color`,
            title: none ? "None" : void 0,
            onClick: () => setOpen((v) => !v),
            className: "relative h-6 w-10 overflow-hidden rounded border border-[var(--border-default)] disabled:cursor-default disabled:opacity-40",
            style: { backgroundColor: none ? "#ffffff" : normalized },
            children: none ? /* @__PURE__ */ jsx7("svg", { className: "absolute inset-0 h-full w-full", viewBox: "0 0 40 24", preserveAspectRatio: "none", "aria-hidden": true, children: /* @__PURE__ */ jsx7("line", { x1: "1", y1: "23", x2: "39", y2: "1", stroke: "var(--text-danger)", strokeWidth: "1.5" }) }) : null
          }
        ),
        children: /* @__PURE__ */ jsxs5("div", { className: `${POPOVER_PANEL} w-40 gap-2 p-2`, children: [
          /* @__PURE__ */ jsx7(
            "input",
            {
              type: "color",
              "aria-label": `${label} color picker`,
              value: normalized,
              onChange: (event) => onCommit(event.target.value),
              className: "h-8 w-full cursor-pointer rounded border border-[var(--border-default)] p-0.5"
            }
          ),
          /* @__PURE__ */ jsx7(
            "input",
            {
              type: "text",
              "aria-label": `${label} hex value`,
              value,
              onChange: (event) => onCommit(event.target.value),
              className: "rounded border border-[var(--border-default)] bg-transparent px-2 py-1 text-xs text-[var(--text-primary)] focus:border-[var(--brand-primary)]"
            }
          )
        ] })
      }
    )
  ] });
}
function Toolbar({
  page,
  selectedElements,
  canWrite,
  mode = "edit",
  canUndo,
  canRedo,
  gridEnabled,
  snapEnabled,
  showRulers,
  showBleed,
  onUndo,
  onRedo,
  onToggleGrid,
  onToggleSnap,
  onToggleRulers,
  onToggleBleed,
  onSetAttrs,
  onSetPageProps,
  onSetPageGuides,
  onReorder,
  onGroup,
  onUngroup,
  onDelete,
  onBindSlot,
  pageSizeLabel = "Page size",
  enableBleedLabel = "Show print bleed"
}) {
  const hasSelection = selectedElements.length > 0;
  const single = selectedElements.length === 1 ? selectedElements[0] : null;
  const allSameKind = selectedElements.length > 0 && selectedElements.every((e) => e.kind === selectedElements[0].kind);
  const firstKind = selectedElements[0]?.kind;
  function patchAll(attrs) {
    for (const el of selectedElements) onSetAttrs(el.id, attrs);
  }
  function reorderSingle(direction) {
    if (!single) return;
    onReorder(single.id, 0, page.elements.length, direction);
  }
  const selectedIds = selectedElements.map((e) => e.id);
  const isGroup = single?.kind === "group";
  const groupable = selectedElements.length >= 2;
  const review = mode === "review";
  return /* @__PURE__ */ jsxs5("div", { className: "flex min-h-11 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--border-default)] bg-[var(--bg-input)] px-3 py-1", children: [
    /* @__PURE__ */ jsxs5("div", { className: "flex shrink-0 items-center gap-2", children: [
      /* @__PURE__ */ jsxs5("div", { className: "flex items-center gap-1", role: "group", "aria-label": "History", children: [
        /* @__PURE__ */ jsx7("button", { type: "button", "aria-label": "Undo", disabled: !canUndo || !canWrite, onClick: onUndo, className: BTN, children: /* @__PURE__ */ jsx7(UndoGlyph, { className: "h-3.5 w-3.5" }) }),
        /* @__PURE__ */ jsx7("button", { type: "button", "aria-label": "Redo", disabled: !canRedo || !canWrite, onClick: onRedo, className: BTN, children: /* @__PURE__ */ jsx7(RedoGlyph, { className: "h-3.5 w-3.5" }) })
      ] }),
      !review ? /* @__PURE__ */ jsxs5(Fragment4, { children: [
        SEP,
        /* @__PURE__ */ jsxs5("div", { className: "flex items-center gap-1", role: "group", "aria-label": "View", children: [
          /* @__PURE__ */ jsx7("span", { className: `${FIELD_LABEL} mr-0.5 hidden md:inline`, "aria-hidden": true, children: "View" }),
          /* @__PURE__ */ jsx7("button", { type: "button", "aria-label": "Toggle rulers", "aria-pressed": showRulers, onClick: onToggleRulers, className: showRulers ? BTN_ACTIVE : BTN, title: "Rulers", children: /* @__PURE__ */ jsx7(RulerGlyph, { className: "h-3.5 w-3.5" }) }),
          /* @__PURE__ */ jsx7("button", { type: "button", "aria-label": "Toggle grid", "aria-pressed": gridEnabled, onClick: onToggleGrid, className: gridEnabled ? BTN_ACTIVE : BTN, title: "Grid", children: /* @__PURE__ */ jsx7(GridGlyph, { className: "h-3.5 w-3.5" }) }),
          /* @__PURE__ */ jsx7("button", { type: "button", "aria-label": "Toggle snap", "aria-pressed": snapEnabled, onClick: onToggleSnap, className: snapEnabled ? BTN_ACTIVE : BTN, title: "Snap to guides", children: /* @__PURE__ */ jsx7(MagnetGlyph, { className: "h-3.5 w-3.5" }) }),
          /* @__PURE__ */ jsx7("button", { type: "button", "aria-label": "Toggle bleed overlay", "aria-pressed": showBleed, onClick: onToggleBleed, className: showBleed ? BTN_ACTIVE : BTN, disabled: !page.bleed, title: "Show print bleed", children: /* @__PURE__ */ jsx7(BleedGlyph, { className: "h-3.5 w-3.5" }) })
        ] })
      ] }) : null
    ] }),
    /* @__PURE__ */ jsx7("div", { className: "flex flex-wrap items-center gap-x-2 gap-y-1", children: hasSelection ? /* @__PURE__ */ jsxs5(Fragment4, { children: [
      SEP,
      /* @__PURE__ */ jsx7(
        SelectionControls,
        {
          elements: selectedElements,
          single,
          isGroup,
          groupable,
          allSameKind,
          firstKind,
          canWrite,
          review,
          patchAll,
          reorderSingle,
          onGroup: () => onGroup(selectedIds),
          onUngroup: () => {
            if (single) onUngroup(single.id);
          },
          onDelete: () => onDelete(selectedIds),
          onBindSlot: single ? (slot) => onBindSlot(single.id, slot) : void 0,
          currentSlot: single?.slot ?? null
        }
      )
    ] }) : !review ? /* @__PURE__ */ jsxs5(Fragment4, { children: [
      SEP,
      /* @__PURE__ */ jsx7(
        PagePropsControls,
        {
          page,
          canWrite,
          onSetPageProps,
          onSetPageGuides,
          pageSizeLabel,
          enableBleedLabel
        }
      )
    ] }) : null })
  ] });
}
function SelectionControls({
  elements,
  single,
  isGroup,
  groupable,
  allSameKind,
  firstKind,
  canWrite,
  review,
  patchAll,
  reorderSingle,
  onGroup,
  onUngroup,
  onDelete,
  onBindSlot,
  currentSlot
}) {
  const [slotPopoverOpen, setSlotPopoverOpen] = useState3(false);
  const [slotInput, setSlotInput] = useState3("");
  const firstEl = elements[0];
  return /* @__PURE__ */ jsxs5(Fragment4, { children: [
    allSameKind && firstKind === "text" && single ? /* @__PURE__ */ jsx7(TextControls, { element: single, canWrite, onPatch: (attrs) => patchAll(attrs) }) : null,
    allSameKind && firstKind === "rect" && single ? /* @__PURE__ */ jsx7(ShapeControls, { element: single, canWrite, onPatch: (attrs) => patchAll(attrs), showCornerRadius: true }) : null,
    allSameKind && firstKind === "ellipse" && single ? /* @__PURE__ */ jsx7(ShapeControls, { element: single, canWrite, onPatch: (attrs) => patchAll(attrs), showCornerRadius: false }) : null,
    allSameKind && firstKind === "image" && single ? /* @__PURE__ */ jsx7(ImageControls, { element: single, canWrite, onPatch: (attrs) => patchAll(attrs) }) : null,
    SEP,
    /* @__PURE__ */ jsx7(
      NumberInput,
      {
        label: "Opacity",
        value: Math.round((firstEl.opacity ?? 1) * 100),
        min: 0,
        onCommit: (v) => patchAll({ opacity: Math.max(0, Math.min(1, v / 100)) }),
        className: "w-14"
      }
    ),
    /* @__PURE__ */ jsx7(
      NumberInput,
      {
        label: "Rotation",
        value: Math.round(firstEl.rotation ?? 0),
        onCommit: (v) => patchAll({ rotation: v }),
        className: "w-14"
      }
    ),
    review ? null : /* @__PURE__ */ jsxs5(Fragment4, { children: [
      SEP,
      single ? /* @__PURE__ */ jsxs5(Fragment4, { children: [
        /* @__PURE__ */ jsx7("button", { type: "button", "aria-label": "Bring to front", disabled: !canWrite, onClick: () => reorderSingle("front"), className: BTN, children: /* @__PURE__ */ jsx7(BringFrontGlyph, { className: "h-3.5 w-3.5" }) }),
        /* @__PURE__ */ jsx7("button", { type: "button", "aria-label": "Send to back", disabled: !canWrite, onClick: () => reorderSingle("back"), className: BTN, children: /* @__PURE__ */ jsx7(SendBackGlyph, { className: "h-3.5 w-3.5" }) }),
        SEP
      ] }) : null,
      groupable ? /* @__PURE__ */ jsx7("button", { type: "button", "aria-label": "Group elements", disabled: !canWrite, onClick: onGroup, className: BTN, children: /* @__PURE__ */ jsx7(GroupGlyph, { className: "h-3.5 w-3.5" }) }) : null,
      isGroup ? /* @__PURE__ */ jsx7("button", { type: "button", "aria-label": "Ungroup", disabled: !canWrite, onClick: onUngroup, className: BTN, children: /* @__PURE__ */ jsx7(UngroupGlyph, { className: "h-3.5 w-3.5" }) }) : null,
      single ? /* @__PURE__ */ jsx7(
        "button",
        {
          type: "button",
          "aria-label": single.locked ? "Unlock element" : "Lock element",
          "aria-pressed": !!single.locked,
          disabled: !canWrite,
          onClick: () => patchAll({ locked: !single.locked }),
          className: single.locked ? BTN_ACTIVE : BTN,
          children: single.locked ? /* @__PURE__ */ jsx7(LockGlyph, { className: "h-3.5 w-3.5" }) : /* @__PURE__ */ jsx7(UnlockGlyph, { className: "h-3.5 w-3.5" })
        }
      ) : null,
      single && onBindSlot ? /* @__PURE__ */ jsx7(
        Popover,
        {
          open: slotPopoverOpen,
          onClose: () => setSlotPopoverOpen(false),
          trigger: /* @__PURE__ */ jsx7(
            "button",
            {
              type: "button",
              "aria-label": currentSlot ? `Slot: ${currentSlot}` : "Bind slot",
              "aria-pressed": !!currentSlot,
              "aria-haspopup": "dialog",
              "aria-expanded": slotPopoverOpen,
              onClick: () => {
                setSlotInput(currentSlot ?? "");
                setSlotPopoverOpen((v) => !v);
              },
              className: currentSlot ? BTN_ACTIVE : BTN,
              title: currentSlot ? `Slot: ${currentSlot}` : "Bind slot",
              children: /* @__PURE__ */ jsx7(SlotGlyph, { className: "h-3.5 w-3.5" })
            }
          ),
          children: /* @__PURE__ */ jsxs5("div", { className: `${POPOVER_PANEL} w-48 gap-2 p-2`, children: [
            /* @__PURE__ */ jsx7(
              "input",
              {
                autoFocus: true,
                value: slotInput,
                onChange: (event) => setSlotInput(event.target.value),
                placeholder: "slot-name",
                className: "rounded border border-[var(--border-default)] bg-transparent px-2 py-1 text-xs text-[var(--text-primary)] focus:border-[var(--brand-primary)]"
              }
            ),
            /* @__PURE__ */ jsxs5("div", { className: "flex gap-2", children: [
              /* @__PURE__ */ jsx7(
                "button",
                {
                  type: "button",
                  onClick: () => {
                    onBindSlot(slotInput.trim() || null);
                    setSlotPopoverOpen(false);
                  },
                  className: "flex-1 rounded border border-[var(--brand-primary)] px-2 py-0.5 text-xs text-[var(--brand-primary)] hover:bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)]",
                  children: slotInput.trim() ? "Bind" : "Unbind"
                }
              ),
              /* @__PURE__ */ jsx7(
                "button",
                {
                  type: "button",
                  onClick: () => setSlotPopoverOpen(false),
                  className: "rounded border border-[var(--border-default)] px-2 py-0.5 text-xs text-[var(--text-secondary)]",
                  children: "Cancel"
                }
              )
            ] })
          ] })
        }
      ) : null,
      SEP,
      /* @__PURE__ */ jsx7(
        "button",
        {
          type: "button",
          "aria-label": "Delete selection",
          disabled: !canWrite,
          onClick: onDelete,
          className: `${BTN} text-[var(--text-danger)] hover:border-[var(--text-danger)] hover:text-[var(--text-danger)]`,
          children: /* @__PURE__ */ jsx7(TrashGlyph, { className: "h-3.5 w-3.5" })
        }
      )
    ] })
  ] });
}
function TextControls({ element, canWrite, onPatch }) {
  return /* @__PURE__ */ jsxs5(Fragment4, { children: [
    /* @__PURE__ */ jsx7(FontPicker, { value: element.fontFamily, disabled: !canWrite, onChange: (fontFamily) => onPatch({ fontFamily }) }),
    /* @__PURE__ */ jsx7(NumberInput, { label: "Size", value: element.fontSize, min: 1, onCommit: (v) => onPatch({ fontSize: v }), className: "w-12" }),
    /* @__PURE__ */ jsx7(
      "button",
      {
        type: "button",
        "aria-label": "Bold",
        "aria-pressed": !!element.fontStyle?.includes("bold"),
        disabled: !canWrite,
        onClick: () => onPatch({ fontStyle: element.fontStyle === "bold" || element.fontStyle === "bold italic" ? element.fontStyle === "bold italic" ? "italic" : "normal" : element.fontStyle === "italic" ? "bold italic" : "bold" }),
        className: element.fontStyle?.includes("bold") ? BTN_ACTIVE : BTN,
        children: /* @__PURE__ */ jsx7(BoldGlyph, { className: "h-3.5 w-3.5" })
      }
    ),
    /* @__PURE__ */ jsx7(
      "button",
      {
        type: "button",
        "aria-label": "Italic",
        "aria-pressed": !!element.fontStyle?.includes("italic"),
        disabled: !canWrite,
        onClick: () => onPatch({ fontStyle: element.fontStyle === "italic" || element.fontStyle === "bold italic" ? element.fontStyle === "bold italic" ? "bold" : "normal" : element.fontStyle === "bold" ? "bold italic" : "italic" }),
        className: element.fontStyle?.includes("italic") ? BTN_ACTIVE : BTN,
        children: /* @__PURE__ */ jsx7(ItalicGlyph, { className: "h-3.5 w-3.5" })
      }
    ),
    /* @__PURE__ */ jsx7("div", { role: "radiogroup", "aria-label": "Text alignment", className: "flex items-center gap-2", children: ["left", "center", "right"].map((align) => /* @__PURE__ */ jsx7(
      "button",
      {
        type: "button",
        role: "radio",
        "aria-label": `Align ${align}`,
        "aria-checked": element.align === align,
        disabled: !canWrite,
        onClick: () => onPatch({ align }),
        className: element.align === align ? BTN_ACTIVE : BTN,
        children: align === "left" ? /* @__PURE__ */ jsx7(AlignLeftGlyph, { className: "h-3.5 w-3.5" }) : align === "center" ? /* @__PURE__ */ jsx7(AlignCenterGlyph, { className: "h-3.5 w-3.5" }) : /* @__PURE__ */ jsx7(AlignRightGlyph, { className: "h-3.5 w-3.5" })
      },
      align
    )) }),
    /* @__PURE__ */ jsx7(NumberInput, { label: "Line H", value: element.lineHeight, step: 0.1, min: 0.5, onCommit: (v) => onPatch({ lineHeight: v }), className: "w-12" }),
    /* @__PURE__ */ jsx7(NumberInput, { label: "Spacing", value: element.letterSpacing, step: 0.5, onCommit: (v) => onPatch({ letterSpacing: v }), className: "w-14" }),
    /* @__PURE__ */ jsx7(ColorSwatch, { label: "Fill", value: element.fill, onCommit: (v) => onPatch({ fill: v }), disabled: !canWrite })
  ] });
}
function ShapeControls({ element, canWrite, onPatch, showCornerRadius }) {
  return /* @__PURE__ */ jsxs5(Fragment4, { children: [
    /* @__PURE__ */ jsx7(ColorSwatch, { label: "Fill", value: element.fill, onCommit: (v) => onPatch({ fill: v }), disabled: !canWrite }),
    /* @__PURE__ */ jsx7(ColorSwatch, { label: "Stroke", value: element.stroke ?? "#000000", onCommit: (v) => onPatch({ stroke: v }), disabled: !canWrite, none: (element.strokeWidth ?? 0) === 0 }),
    /* @__PURE__ */ jsx7(NumberInput, { label: "Stroke W", value: element.strokeWidth ?? 0, min: 0, onCommit: (v) => onPatch({ strokeWidth: v }), className: "w-14" }),
    showCornerRadius && "cornerRadius" in element ? /* @__PURE__ */ jsx7(NumberInput, { label: "Corner R", value: element.cornerRadius ?? 0, min: 0, onCommit: (v) => onPatch({ cornerRadius: v }), className: "w-14" }) : null
  ] });
}
function ImageControls({ element, canWrite, onPatch }) {
  const [swapOpen, setSwapOpen] = useState3(false);
  const [swapUrl, setSwapUrl] = useState3("");
  return /* @__PURE__ */ jsxs5(Fragment4, { children: [
    /* @__PURE__ */ jsx7(
      SelectControl,
      {
        label: "Fit",
        value: element.fit,
        disabled: !canWrite,
        onChange: (fit) => onPatch({ fit }),
        buttonClassName: "w-24",
        options: [
          { value: "fill", label: "Fill" },
          { value: "cover", label: "Cover" },
          { value: "contain", label: "Contain" }
        ]
      }
    ),
    /* @__PURE__ */ jsx7(
      Popover,
      {
        open: swapOpen,
        onClose: () => setSwapOpen(false),
        trigger: /* @__PURE__ */ jsx7(
          "button",
          {
            type: "button",
            "aria-label": "Replace image",
            disabled: !canWrite,
            onClick: () => {
              setSwapUrl(element.src);
              setSwapOpen((v) => !v);
            },
            className: BTN,
            title: "Replace image",
            children: /* @__PURE__ */ jsx7(SwapGlyph, { className: "h-3.5 w-3.5" })
          }
        ),
        children: /* @__PURE__ */ jsxs5("div", { className: `${POPOVER_PANEL} w-64 gap-2 p-2`, children: [
          /* @__PURE__ */ jsx7(
            "input",
            {
              autoFocus: true,
              value: swapUrl,
              onChange: (event) => setSwapUrl(event.target.value),
              placeholder: "https://\u2026 image URL",
              "aria-label": "New image URL",
              className: "rounded border border-[var(--border-default)] bg-transparent px-2 py-1 text-xs text-[var(--text-primary)] focus:border-[var(--brand-primary)]"
            }
          ),
          /* @__PURE__ */ jsxs5("div", { className: "flex gap-2", children: [
            /* @__PURE__ */ jsx7(
              "button",
              {
                type: "button",
                disabled: !swapUrl.trim() || swapUrl.trim() === element.src,
                onClick: () => {
                  onPatch({ src: swapUrl.trim() });
                  setSwapOpen(false);
                },
                className: "flex-1 rounded border border-[var(--brand-primary)] px-2 py-0.5 text-xs text-[var(--brand-primary)] hover:bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] disabled:cursor-default disabled:opacity-40",
                children: "Replace"
              }
            ),
            /* @__PURE__ */ jsx7(
              "button",
              {
                type: "button",
                onClick: () => setSwapOpen(false),
                className: "rounded border border-[var(--border-default)] px-2 py-0.5 text-xs text-[var(--text-secondary)]",
                children: "Cancel"
              }
            )
          ] })
        ] })
      }
    )
  ] });
}
function PagePropsControls({ page, canWrite, onSetPageProps, onSetPageGuides, pageSizeLabel = "Page size", enableBleedLabel = "Show print bleed" }) {
  const matchedPreset = matchPreset(page.width, page.height);
  const [customW, setCustomW] = useState3(null);
  const [customH, setCustomH] = useState3(null);
  function commitDimension(dim, raw) {
    const v = parseFloat(raw);
    if (Number.isFinite(v) && v > 0) onSetPageProps({ [dim]: v });
    if (dim === "width") setCustomW(null);
    else setCustomH(null);
  }
  const presetOptions = [
    { value: "custom", label: "Custom" },
    ...SIZE_PRESETS.map((p) => ({ value: p.id, label: p.label }))
  ];
  return /* @__PURE__ */ jsxs5(Fragment4, { children: [
    /* @__PURE__ */ jsx7(
      "input",
      {
        type: "text",
        "aria-label": "Page name",
        value: page.name,
        disabled: !canWrite,
        onChange: (event) => onSetPageProps({ name: event.target.value }),
        className: "w-28 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-2 py-0.5 text-xs text-[var(--text-primary)] focus:border-[var(--brand-primary)] disabled:cursor-default disabled:opacity-40"
      }
    ),
    SEP,
    /* @__PURE__ */ jsx7(
      SelectControl,
      {
        label: pageSizeLabel,
        value: matchedPreset?.id ?? "custom",
        disabled: !canWrite,
        onChange: (id) => {
          const preset = SIZE_PRESETS.find((p) => p.id === id);
          if (preset) onSetPageProps({ width: preset.width, height: preset.height });
        },
        options: presetOptions,
        buttonClassName: "w-44"
      }
    ),
    /* @__PURE__ */ jsxs5("label", { className: "flex flex-col items-center gap-0.5", children: [
      /* @__PURE__ */ jsx7("span", { className: FIELD_LABEL, children: "W" }),
      /* @__PURE__ */ jsx7(
        "input",
        {
          type: "number",
          value: customW ?? page.width,
          min: 1,
          disabled: !canWrite,
          onChange: (event) => setCustomW(event.target.value),
          onBlur: (event) => commitDimension("width", event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") commitDimension("width", event.target.value);
            if (event.key === "Escape") setCustomW(null);
          },
          className: "w-16 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-1 py-0.5 text-center text-xs text-[var(--text-primary)] focus:border-[var(--brand-primary)] disabled:cursor-default disabled:opacity-40"
        }
      )
    ] }),
    /* @__PURE__ */ jsx7("span", { className: "text-[var(--text-muted)]", children: "\xD7" }),
    /* @__PURE__ */ jsxs5("label", { className: "flex flex-col items-center gap-0.5", children: [
      /* @__PURE__ */ jsx7("span", { className: FIELD_LABEL, children: "H" }),
      /* @__PURE__ */ jsx7(
        "input",
        {
          type: "number",
          value: customH ?? page.height,
          min: 1,
          disabled: !canWrite,
          onChange: (event) => setCustomH(event.target.value),
          onBlur: (event) => commitDimension("height", event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") commitDimension("height", event.target.value);
            if (event.key === "Escape") setCustomH(null);
          },
          className: "w-16 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-1 py-0.5 text-center text-xs text-[var(--text-primary)] focus:border-[var(--brand-primary)] disabled:cursor-default disabled:opacity-40"
        }
      )
    ] }),
    SEP,
    /* @__PURE__ */ jsx7(ColorSwatch, { label: "BG", value: page.background, onCommit: (v) => onSetPageProps({ background: v }), disabled: !canWrite }),
    SEP,
    /* @__PURE__ */ jsx7(BleedControls, { page, canWrite, onSetPageProps, enableBleedLabel })
  ] });
}
function BleedControls({ page, canWrite, onSetPageProps, enableBleedLabel = "Show print bleed" }) {
  const bleed = page.bleed;
  function setBleedSide(side, value) {
    const current = bleed ?? { top: 0, right: 0, bottom: 0, left: 0 };
    onSetPageProps({ bleed: { ...current, [side]: value } });
  }
  if (!bleed) {
    return /* @__PURE__ */ jsx7(
      "button",
      {
        type: "button",
        "aria-label": enableBleedLabel,
        disabled: !canWrite,
        onClick: () => onSetPageProps({ bleed: { top: 3, right: 3, bottom: 3, left: 3 } }),
        className: BTN,
        title: enableBleedLabel,
        children: /* @__PURE__ */ jsx7(BleedGlyph, { className: "h-3.5 w-3.5" })
      }
    );
  }
  return /* @__PURE__ */ jsxs5(Fragment4, { children: [
    ["top", "right", "bottom", "left"].map((side) => /* @__PURE__ */ jsx7(
      NumberInput,
      {
        label: side[0].toUpperCase() + side.slice(1),
        value: bleed[side],
        min: 0,
        onCommit: (v) => setBleedSide(side, v),
        className: "w-12"
      },
      side
    )),
    /* @__PURE__ */ jsx7(
      "button",
      {
        type: "button",
        disabled: !canWrite,
        onClick: () => onSetPageProps({ bleed: null }),
        className: BTN,
        title: "Remove print bleed",
        "aria-label": "Remove print bleed",
        children: "\xD7"
      }
    )
  ] });
}

// src/design-canvas-react/components/ZoomControls.tsx
import { jsx as jsx8, jsxs as jsxs6 } from "react/jsx-runtime";
var STEP = 0.1;
var MIN = 0.05;
var MAX = 32;
function ZoomControls({ zoom, onZoom, onFit, fitLabel = "Fit to screen" }) {
  function zoomOut() {
    onZoom(Math.max(MIN, parseFloat((zoom - STEP).toFixed(4))));
  }
  function zoomIn() {
    onZoom(Math.min(MAX, parseFloat((zoom + STEP).toFixed(4))));
  }
  function resetHundred() {
    onZoom(1);
  }
  return /* @__PURE__ */ jsxs6("div", { className: "flex items-center gap-1 px-2", children: [
    /* @__PURE__ */ jsx8(
      "button",
      {
        type: "button",
        "aria-label": fitLabel,
        onClick: onFit,
        className: BTN_SM,
        title: `${fitLabel} (F)`,
        children: /* @__PURE__ */ jsx8(ZoomFitGlyph, { className: "h-3.5 w-3.5" })
      }
    ),
    /* @__PURE__ */ jsx8(
      "button",
      {
        type: "button",
        "aria-label": "Zoom out",
        onClick: zoomOut,
        disabled: zoom <= MIN,
        className: BTN_SM,
        children: /* @__PURE__ */ jsx8(MinusGlyph, { className: "h-3.5 w-3.5" })
      }
    ),
    /* @__PURE__ */ jsxs6(
      "button",
      {
        type: "button",
        "aria-label": "Reset to 100%",
        onClick: resetHundred,
        className: "rounded px-1.5 py-0.5 font-mono text-xs tabular-nums text-[var(--text-secondary)] transition hover:bg-[var(--border-default)] hover:text-[var(--text-primary)]",
        title: "Reset to 100%",
        children: [
          Math.round(zoom * 100),
          "%"
        ]
      }
    ),
    /* @__PURE__ */ jsx8(
      "button",
      {
        type: "button",
        "aria-label": "Zoom in",
        onClick: zoomIn,
        disabled: zoom >= MAX,
        className: BTN_SM,
        children: /* @__PURE__ */ jsx8(PlusGlyph, { className: "h-3.5 w-3.5" })
      }
    )
  ] });
}

// src/design-canvas-react/components/ExportControl.tsx
import { useRef as useRef4, useState as useState4 } from "react";
import { jsx as jsx9, jsxs as jsxs7 } from "react/jsx-runtime";
var FORMATS = [
  { id: "png", label: "PNG" },
  { id: "jpeg", label: "JPEG" }
];
var SCALES = [
  { value: 1, label: "1x" },
  { value: 2, label: "2x" }
];
var FIELD_LABEL2 = "text-xs font-semibold uppercase tracking-[0.05em] text-[var(--text-muted)]";
function ExportControl({ defaults, onExport, className }) {
  const [open, setOpen] = useState4(false);
  const [format, setFormat] = useState4(defaults?.format ?? "png");
  const [pixelRatio, setPixelRatio] = useState4(defaults?.pixelRatio ?? 1);
  const containerRef = useRef4(null);
  function confirm() {
    onExport({ format, pixelRatio });
    setOpen(false);
  }
  return /* @__PURE__ */ jsxs7("div", { ref: containerRef, className: `relative ${className ?? ""}`, children: [
    /* @__PURE__ */ jsxs7(
      "button",
      {
        type: "button",
        "aria-label": "Export",
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        onClick: () => setOpen((v) => !v),
        onBlur: (event) => {
          if (!containerRef.current?.contains(event.relatedTarget)) {
            setOpen(false);
          }
        },
        className: "flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-default)] px-2.5 text-xs font-medium text-[var(--text-primary)] transition-colors hover:border-[color-mix(in_srgb,var(--brand-primary)_40%,transparent)]",
        children: [
          /* @__PURE__ */ jsx9(ExportGlyph, { className: "h-3.5 w-3.5" }),
          "Export",
          /* @__PURE__ */ jsx9(ChevronDownGlyph, { className: "h-3 w-3 text-[var(--text-muted)]" })
        ]
      }
    ),
    open ? /* @__PURE__ */ jsxs7(
      "div",
      {
        role: "dialog",
        "aria-label": "Export options",
        onBlur: (event) => {
          if (!containerRef.current?.contains(event.relatedTarget)) {
            setOpen(false);
          }
        },
        className: "absolute right-0 top-full z-50 mt-1 flex w-52 flex-col gap-3 rounded-md border border-[var(--card-edge)] bg-[hsl(var(--popover))] p-3 shadow-[var(--shadow-overlay)]",
        children: [
          /* @__PURE__ */ jsxs7("div", { className: "flex flex-col gap-1.5", children: [
            /* @__PURE__ */ jsx9("span", { className: FIELD_LABEL2, children: "Format" }),
            /* @__PURE__ */ jsx9("div", { className: "flex gap-1.5", children: FORMATS.map((f) => /* @__PURE__ */ jsx9(
              "button",
              {
                type: "button",
                "aria-pressed": format === f.id,
                onClick: () => setFormat(f.id),
                className: `flex-1 rounded border px-2 py-1 text-xs transition-colors ${format === f.id ? "border-[var(--brand-primary)] text-[var(--brand-primary)]" : "border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`,
                children: f.label
              },
              f.id
            )) })
          ] }),
          /* @__PURE__ */ jsxs7("div", { className: "flex flex-col gap-1.5", children: [
            /* @__PURE__ */ jsx9("span", { className: FIELD_LABEL2, children: "Scale" }),
            /* @__PURE__ */ jsx9("div", { className: "flex gap-1.5", children: SCALES.map((s) => /* @__PURE__ */ jsx9(
              "button",
              {
                type: "button",
                "aria-pressed": pixelRatio === s.value,
                onClick: () => setPixelRatio(s.value),
                className: `flex-1 rounded border px-2 py-1 text-xs transition-colors ${pixelRatio === s.value ? "border-[var(--brand-primary)] text-[var(--brand-primary)]" : "border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`,
                children: s.label
              },
              s.value
            )) })
          ] }),
          /* @__PURE__ */ jsx9(
            "button",
            {
              type: "button",
              "aria-label": "Export image",
              onClick: confirm,
              className: "rounded border border-[var(--brand-primary)] px-2 py-1 text-xs font-medium text-[var(--brand-primary)] transition-colors hover:bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)]",
              children: "Export"
            }
          )
        ]
      }
    ) : null
  ] });
}

// src/design-canvas-react/components/DesignCanvas.tsx
import { jsx as jsx10, jsxs as jsxs8 } from "react/jsx-runtime";
function mintId() {
  const uuid = globalThis.crypto && "randomUUID" in globalThis.crypto ? globalThis.crypto.randomUUID() : null;
  return `local-${uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}
function isTypingTarget(target) {
  return target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]') !== null;
}
function useCommitCommand(stack, onApplyOperations, canWrite, setError) {
  return useCallback2(
    (command) => {
      if (!canWrite) return;
      try {
        stack.execute(command);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
        return;
      }
      const ops = command.operations();
      void onApplyOperations(ops).then((result) => {
        if (result.document) {
          stack.reset(result.document);
        }
      }).catch((error) => {
        stack.rollback(command);
        setError(error instanceof Error ? error.message : String(error));
      });
    },
    [stack, onApplyOperations, canWrite, setError]
  );
}
function DesignCanvas({
  document: initialDocument,
  rev: initialRev,
  canWrite,
  mode = "edit",
  onApplyOperations,
  onSelectionChange,
  renderAgentPanel,
  renderSidePanel,
  onExport,
  exportDefaults,
  className,
  fitOnMount,
  onReady,
  render,
  showEmptyState,
  onAskAgent,
  pageSizeLabel,
  enableBleedLabel,
  fitLabel,
  renderWorkspace,
  renderThumbnail
}) {
  const stack = useMemo(
    () => createSceneCommandStack(initialDocument, initialDocument.pages[0]?.id ?? "page-1"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const editorState = useSyncExternalStore(stack.subscribe, stack.getState, stack.getState);
  const appliedDocumentRef = useRef5(initialDocument);
  useEffect3(() => {
    if (appliedDocumentRef.current === initialDocument) return;
    appliedDocumentRef.current = initialDocument;
    stack.reset(initialDocument);
  }, [initialDocument, stack]);
  const [commitError, setCommitError] = useState5(null);
  const commit = useCommitCommand(stack, onApplyOperations, canWrite, setCommitError);
  const selectionChangeRef = useRef5(onSelectionChange);
  selectionChangeRef.current = onSelectionChange;
  useEffect3(() => {
    const page = editorState.document.pages.find((p) => p.id === editorState.activePageId);
    if (!page) return;
    const selected = editorState.selectedElementIds.map((id) => page.elements.find((el) => el.id === id)).filter((el) => el !== void 0);
    selectionChangeRef.current?.(selected);
  }, [editorState.selectedElementIds, editorState.activePageId, editorState.document]);
  const fitRef = useRef5(null);
  const exportRef = useRef5(null);
  const setZoom = useCallback2((zoom) => stack.setView({ zoom }), [stack]);
  const setPan = useCallback2((panX, panY) => stack.setView({ panX, panY }), [stack]);
  const setActivePage = useCallback2((activePageId) => stack.setView({ activePageId, selectedElementIds: [] }), [stack]);
  const setSelectedElements = useCallback2(
    (ids, additive) => {
      if (!additive) {
        stack.setView({ selectedElementIds: ids });
        return;
      }
      const current = new Set(editorState.selectedElementIds);
      for (const id of ids) {
        if (current.has(id)) current.delete(id);
        else current.add(id);
      }
      stack.setView({ selectedElementIds: [...current] });
    },
    [stack, editorState.selectedElementIds]
  );
  const handleSetAttrs = useCallback2(
    (elementId, attrs) => {
      const page = requirePage(editorState.document, editorState.activePageId);
      const found = findElement(page, elementId);
      if (!found) return;
      if (found.element.locked) return;
      const priorAttrs = Object.fromEntries(
        Object.keys(attrs).map((k) => [k, found.element[k]])
      );
      commit(
        setAttrsCommand({
          pageId: editorState.activePageId,
          elementId,
          attrs,
          priorAttrs
        })
      );
    },
    [commit, editorState.activePageId, editorState.document]
  );
  const handleMultiSetAttrs = useCallback2(
    (patches) => {
      const page = requirePage(editorState.document, editorState.activePageId);
      const entries = patches.flatMap(({ elementId, attrs }) => {
        const found = findElement(page, elementId);
        if (!found || found.element.locked) return [];
        const priorAttrs = Object.fromEntries(
          Object.keys(attrs).map((k) => [k, found.element[k]])
        );
        return [{ pageId: editorState.activePageId, elementId, attrs, priorAttrs }];
      });
      if (entries.length === 0) return;
      commit(multiSetAttrsCommand(entries));
    },
    [commit, editorState.activePageId, editorState.document]
  );
  const handleReorder = useCallback2(
    (elementId, toIndex, ownerLength, direction) => {
      const page = requirePage(editorState.document, editorState.activePageId);
      const found = findElement(page, elementId);
      if (!found) return;
      const currentIndex = found.index;
      const target = direction === "front" ? topIndex(ownerLength) : direction === "back" ? 0 : direction === "forward" ? indexForward(currentIndex, ownerLength) : indexBackward(currentIndex);
      const clamped = clampIndex(target, ownerLength);
      if (clamped === currentIndex) return;
      commit(reorderElementCommand({ pageId: editorState.activePageId, elementId, toIndex: clamped }));
    },
    [commit, editorState.activePageId, editorState.document]
  );
  const handleDelete = useCallback2(
    (elementIds) => {
      for (const elementId of elementIds) {
        commit(
          deleteElementCommand({
            document: editorState.document,
            pageId: editorState.activePageId,
            elementId
          })
        );
      }
    },
    [commit, editorState.document, editorState.activePageId]
  );
  const handleGroup = useCallback2(
    (elementIds) => {
      commit(
        groupElementsCommand({
          document: editorState.document,
          pageId: editorState.activePageId,
          elementIds,
          groupId: mintId()
        })
      );
    },
    [commit, editorState.document, editorState.activePageId]
  );
  const handleUngroup = useCallback2(
    (groupId) => {
      commit(ungroupElementCommand({ document: editorState.document, pageId: editorState.activePageId, groupId }));
    },
    [commit, editorState.document, editorState.activePageId]
  );
  const handleBindSlot = useCallback2(
    (elementId, slot) => {
      commit(bindSlotCommand({ document: editorState.document, pageId: editorState.activePageId, elementId, slot }));
    },
    [commit, editorState.document, editorState.activePageId]
  );
  const handleSetPageProps = useCallback2(
    (props) => {
      commit(setPagePropsCommand({ document: editorState.document, pageId: editorState.activePageId, props }));
    },
    [commit, editorState.document, editorState.activePageId]
  );
  const handleSetPageGuides = useCallback2(
    (guides) => {
      commit(setPageGuidesCommand({ document: editorState.document, pageId: editorState.activePageId, guides }));
    },
    [commit, editorState.document, editorState.activePageId]
  );
  const handleAddPage = useCallback2(() => {
    const pageId = mintId();
    commit(addPageCommand({ pageId }));
    setActivePage(pageId);
  }, [commit, setActivePage]);
  const handleDuplicatePage = useCallback2(
    (sourcePageId) => {
      const pageId = mintId();
      commit(duplicatePageCommand({ document: editorState.document, sourcePageId, pageId }));
      setActivePage(pageId);
    },
    [commit, editorState.document, setActivePage]
  );
  const handleDeletePage = useCallback2(
    (pageId) => {
      commit(deletePageCommand({ document: editorState.document, pageId }));
    },
    [commit, editorState.document]
  );
  const handleReorderPage = useCallback2(
    (pageId, toIndex) => {
      commit(reorderPageCommand({ pageId, toIndex }));
    },
    [commit]
  );
  const handleUndo = useCallback2(() => {
    if (!canWrite || !stack.canUndo()) return;
    let command;
    try {
      command = stack.undo();
    } catch (error) {
      setCommitError(`Undo failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    void onApplyOperations(command.inverseOperations()).then((result) => {
      if (result.document) stack.reset(result.document);
    }).catch((error) => {
      stack.reexecute(command);
      setCommitError(error instanceof Error ? error.message : String(error));
    });
  }, [stack, canWrite, onApplyOperations]);
  const handleRedo = useCallback2(() => {
    if (!canWrite || !stack.canRedo()) return;
    let command;
    try {
      command = stack.redo();
    } catch (error) {
      setCommitError(`Redo failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    void onApplyOperations(command.operations()).then((result) => {
      if (result.document) stack.reset(result.document);
    }).catch((error) => {
      stack.reundo(command);
      setCommitError(error instanceof Error ? error.message : String(error));
    });
  }, [stack, canWrite, onApplyOperations]);
  useEffect3(() => {
    function onKeyDown(event) {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !isTypingTarget(event.target)) {
        if (event.key.toLowerCase() === "z") {
          event.preventDefault();
          if (event.shiftKey) handleRedo();
          else handleUndo();
          return;
        }
        if (event.key.toLowerCase() === "y") {
          event.preventDefault();
          handleRedo();
          return;
        }
      }
      if ((event.key === "Delete" || event.key === "Backspace") && !isTypingTarget(event.target)) {
        if (!canWrite || editorState.selectedElementIds.length === 0) return;
        event.preventDefault();
        handleDelete(editorState.selectedElementIds);
        return;
      }
      if (event.key.toLowerCase() === "f" && !isTypingTarget(event.target)) {
        event.preventDefault();
        fitRef.current?.();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
  const activePage = useMemo(
    () => editorState.document.pages.find((p) => p.id === editorState.activePageId),
    [editorState.document, editorState.activePageId]
  );
  const selectedElements = useMemo(() => {
    if (!activePage) return [];
    return editorState.selectedElementIds.map((id) => activePage.elements.find((el) => el.id === id)).filter((el) => el !== void 0);
  }, [activePage, editorState.selectedElementIds]);
  const review = mode === "review";
  if (!activePage) {
    return /* @__PURE__ */ jsx10("div", { className: `flex h-full items-center justify-center bg-[var(--bg-input)] ${className ?? ""}`, children: /* @__PURE__ */ jsx10("p", { className: "text-xs text-[var(--text-muted)]", children: "This document has no pages." }) });
  }
  const bleedScreen = editorState.showBleed && activePage.bleed ? {
    top: activePage.bleed.top * editorState.zoom,
    right: activePage.bleed.right * editorState.zoom,
    bottom: activePage.bleed.bottom * editorState.zoom,
    left: activePage.bleed.left * editorState.zoom
  } : null;
  return /* @__PURE__ */ jsxs8("div", { className: `flex h-full min-h-0 bg-[var(--bg-input)] text-[var(--text-primary)] ${className ?? ""}`, children: [
    renderSidePanel && !review ? /* @__PURE__ */ jsx10("aside", { className: "hidden w-64 shrink-0 flex-col overflow-hidden border-r border-[var(--border-default)] lg:flex", children: renderSidePanel({ selectedElements, activePageId: activePage.id, activePage }) }) : null,
    /* @__PURE__ */ jsxs8("div", { className: "flex min-w-0 flex-1 flex-col", children: [
      /* @__PURE__ */ jsxs8("div", { className: "flex shrink-0 items-stretch", children: [
        /* @__PURE__ */ jsx10("div", { className: "min-w-0 flex-1", children: /* @__PURE__ */ jsx10(
          Toolbar,
          {
            page: activePage,
            selectedElements,
            canWrite,
            mode,
            canUndo: stack.canUndo(),
            canRedo: stack.canRedo(),
            gridEnabled: editorState.gridEnabled,
            snapEnabled: editorState.snapEnabled,
            showRulers: editorState.showRulers,
            showBleed: editorState.showBleed,
            onUndo: handleUndo,
            onRedo: handleRedo,
            onToggleGrid: () => stack.setView({ gridEnabled: !editorState.gridEnabled }),
            onToggleSnap: () => stack.setView({ snapEnabled: !editorState.snapEnabled }),
            onToggleRulers: () => stack.setView({ showRulers: !editorState.showRulers }),
            onToggleBleed: () => stack.setView({ showBleed: !editorState.showBleed }),
            onSetAttrs: handleSetAttrs,
            onSetPageProps: handleSetPageProps,
            onSetPageGuides: handleSetPageGuides,
            onReorder: handleReorder,
            onGroup: handleGroup,
            onUngroup: handleUngroup,
            onDelete: handleDelete,
            onBindSlot: handleBindSlot,
            pageSizeLabel,
            enableBleedLabel
          }
        ) }),
        onExport ? /* @__PURE__ */ jsx10("div", { className: "flex shrink-0 items-center border-b border-l border-[var(--border-default)] bg-[var(--bg-input)] px-2", children: /* @__PURE__ */ jsx10(
          ExportControl,
          {
            defaults: exportDefaults,
            onExport: (opts) => exportRef.current?.(opts)
          }
        ) }) : null
      ] }),
      commitError ? /* @__PURE__ */ jsxs8(
        "div",
        {
          className: "flex shrink-0 items-center justify-between gap-3 border-b border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.1)] px-3 py-1.5 text-xs text-[var(--text-danger)]",
          role: "alert",
          children: [
            /* @__PURE__ */ jsx10("span", { className: "min-w-0 truncate", children: commitError }),
            /* @__PURE__ */ jsx10(
              "button",
              {
                type: "button",
                onClick: () => setCommitError(null),
                className: "shrink-0 underline-offset-2 hover:underline",
                children: "Dismiss"
              }
            )
          ]
        }
      ) : null,
      /* @__PURE__ */ jsxs8("div", { className: "flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center sm:hidden", children: [
        /* @__PURE__ */ jsx10(BrandKnot, { size: 32, className: "shrink-0" }),
        /* @__PURE__ */ jsxs8("div", { className: "flex flex-col gap-1", children: [
          /* @__PURE__ */ jsx10("p", { className: "text-sm font-semibold text-[var(--text-primary)]", children: "Best edited on a larger screen" }),
          /* @__PURE__ */ jsx10("p", { className: "text-xs leading-5 text-[var(--text-secondary)]", children: "Open this on a tablet or desktop to edit and export." })
        ] })
      ] }),
      /* @__PURE__ */ jsxs8("div", { className: `relative hidden min-h-0 flex-1 sm:block ${editorState.showRulers ? "pl-[20px] pt-[20px]" : ""}`, children: [
        /* @__PURE__ */ jsx10(
          Rulers,
          {
            pageWidth: activePage.width,
            pageHeight: activePage.height,
            zoom: editorState.zoom,
            scrollLeft: -editorState.panX / editorState.zoom,
            scrollTop: -editorState.panY / editorState.zoom,
            showRulers: editorState.showRulers,
            guides: activePage.guides,
            onGuidesChange: handleSetPageGuides
          }
        ),
        bleedScreen && activePage.bleed ? /* @__PURE__ */ jsx10(
          "div",
          {
            className: "pointer-events-none absolute inset-0 z-10 overflow-hidden",
            "aria-hidden": true,
            children: /* @__PURE__ */ jsx10(
              "div",
              {
                style: {
                  position: "absolute",
                  left: editorState.panX + (editorState.showRulers ? 20 : 0),
                  top: editorState.panY + (editorState.showRulers ? 20 : 0)
                },
                children: /* @__PURE__ */ jsx10(
                  BleedTrimOverlay,
                  {
                    pageWidthPx: activePage.width * editorState.zoom,
                    pageHeightPx: activePage.height * editorState.zoom,
                    bleed: bleedScreen
                  }
                )
              }
            )
          }
        ) : null,
        renderWorkspace({
          document: editorState.document,
          activePageId: editorState.activePageId,
          selectedElementIds: editorState.selectedElementIds,
          zoom: editorState.zoom,
          panX: editorState.panX,
          panY: editorState.panY,
          gridEnabled: editorState.gridEnabled,
          gridSize: editorState.gridSize,
          snapEnabled: editorState.snapEnabled,
          showBleed: editorState.showBleed,
          canWrite,
          stack,
          activePage,
          onFitRef: fitRef,
          onExportRef: exportRef,
          fitOnMount,
          onReady,
          render,
          // Review mode hides authoring affordances; the empty state's doors
          // create content, so they only belong on the editor surface.
          showEmptyState: review ? false : showEmptyState,
          onAskAgent,
          onZoomChange: setZoom,
          onPanChange: setPan,
          onSelectElements: setSelectedElements
        })
      ] }),
      /* @__PURE__ */ jsxs8("div", { className: "flex shrink-0 items-stretch border-t border-[var(--border-default)]", children: [
        /* @__PURE__ */ jsx10("div", { className: "min-w-0 flex-1 overflow-hidden", children: /* @__PURE__ */ jsx10(
          PagesStrip,
          {
            pages: editorState.document.pages,
            activePageId: editorState.activePageId,
            canWrite,
            canManagePages: !review,
            renderThumbnail,
            onSelectPage: setActivePage,
            onAddPage: handleAddPage,
            onDuplicatePage: handleDuplicatePage,
            onDeletePage: handleDeletePage,
            onReorderPage: handleReorderPage
          }
        ) }),
        /* @__PURE__ */ jsx10("div", { className: "flex shrink-0 items-center border-l border-[var(--border-default)]", children: /* @__PURE__ */ jsx10(
          ZoomControls,
          {
            zoom: editorState.zoom,
            onZoom: setZoom,
            onFit: () => fitRef.current?.(),
            fitLabel
          }
        ) })
      ] })
    ] }),
    renderAgentPanel ? /* @__PURE__ */ jsx10("aside", { className: "hidden w-80 shrink-0 flex-col overflow-hidden border-l border-[var(--border-default)] lg:flex", children: renderAgentPanel({ selectedElements, activePageId: editorState.activePageId }) }) : null
  ] });
}

export {
  BrandKnot,
  selectTickStep,
  buildRulerTicks,
  formatRulerLabel,
  BleedTrimOverlay,
  EyeGlyph,
  EyeOffGlyph,
  LockGlyph,
  UnlockGlyph,
  GroupGlyph,
  PlusGlyph,
  RectGlyph,
  EllipseGlyph,
  LineGlyph,
  TextGlyph,
  ImageGlyph,
  VideoGlyph,
  SlotGlyph,
  ShapesGlyph,
  BTN,
  BTN_ACTIVE,
  BTN_SM,
  BTN_SM_ACTIVE,
  IconButton,
  PagesStrip,
  Rulers,
  Toolbar,
  ZoomControls,
  ExportControl,
  DesignCanvas
};
//# sourceMappingURL=chunk-KWN5PGXM.js.map