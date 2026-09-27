import {
  BleedTrimOverlay,
  BrandKnot,
  DesignCanvas,
  PlusGlyph,
  ShapesGlyph
} from "./chunk-KWN5PGXM.js";
import {
  lightTheme
} from "./chunk-Q2QKEV6J.js";
import {
  DEFAULT_INSERT_TEMPLATES,
  collectGridTargets,
  createSnapEngine,
  createZoomPanMath,
  documentCropToStageCoords,
  hitTestPoint,
  identifyTaintedSrc,
  isExportHiddenNodeName,
  marqueeSelect,
  resolveExportParams,
  resolveNodeCachePixelRatio
} from "./chunk-2WVBGQ2Y.js";
import {
  addElementCommand,
  createSceneCommandStack,
  deleteElementCommand,
  groupElementsCommand,
  multiSetAttrsCommand,
  setAttrsCommand,
  ungroupElementCommand
} from "./chunk-FEVVF6JJ.js";
import {
  SCENE_SCHEMA_VERSION,
  boundsIntersect,
  elementAabb,
  findElement
} from "./chunk-BWQPVS7D.js";

// src/design-canvas-react/components/Workspace.tsx
import {
  useCallback,
  useEffect as useEffect4,
  useLayoutEffect,
  useMemo,
  useRef as useRef4,
  useState as useState2
} from "react";
import { Stage, Layer as Layer4, Rect as Rect2, Group as Group3 } from "react-konva";

// src/design-canvas-react/export.ts
function clearNodeCaches(stage) {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const cleared = [];
  const walk = (node) => {
    if (node.isCached()) {
      cleared.push({ node, pixelRatio: resolveNodeCachePixelRatio(node.getAbsoluteScale().x, dpr) });
      node.clearCache();
    }
    for (const child of node.getChildren?.() ?? []) walk(child);
  };
  for (const layer of stage.getLayers()) {
    for (const child of layer.getChildren()) walk(child);
  }
  return cleared;
}
function restoreNodeCaches(cleared) {
  for (const { node, pixelRatio } of cleared) {
    node.cache({ pixelRatio });
  }
}
async function exportPageDataUrl(stage, page, opts) {
  const { cropRect, pixelRatio, mimeType, quality } = resolveExportParams(page, opts);
  const imageSrcs = collectImageSrcs(stage);
  const hiddenNodes = [];
  for (const layer of stage.getLayers()) {
    for (const node of layer.getChildren()) {
      const name = node.name();
      if (isExportHiddenNodeName(name) && node.visible()) {
        node.visible(false);
        hiddenNodes.push(node);
      }
    }
  }
  const stageScale = stage.scaleX();
  const stageCrop = documentCropToStageCoords(cropRect, stageScale, stage.x(), stage.y());
  const clearedCaches = clearNodeCaches(stage);
  let dataUrl;
  try {
    dataUrl = stage.toDataURL({
      mimeType,
      ...quality !== void 0 ? { quality } : {},
      pixelRatio,
      x: stageCrop.x,
      y: stageCrop.y,
      width: stageCrop.width,
      height: stageCrop.height
    });
  } catch (err) {
    for (const node of hiddenNodes) {
      node.visible(true);
    }
    restoreNodeCaches(clearedCaches);
    if (err instanceof Error && err.name === "SecurityError") {
      const taintedSrc = identifyTaintedSrc(imageSrcs);
      if (taintedSrc !== null) {
        throw new Error(
          `Export failed: image source is CORS-tainted and cannot be read by the canvas. Offending src: "${taintedSrc}". Ensure the image is served with Access-Control-Allow-Origin or use a proxied /api/ path.`
        );
      }
      throw new Error(
        `Export failed: a canvas SecurityError occurred but no cross-origin image src could be identified. The stage may contain a tainted video or image loaded without CORS headers.`
      );
    }
    throw err;
  }
  for (const node of hiddenNodes) {
    node.visible(true);
  }
  restoreNodeCaches(clearedCaches);
  return dataUrl;
}
function collectImageSrcs(stage) {
  const result = [];
  for (const layer of stage.getLayers()) {
    for (const node of layer.getChildren()) {
      const src = node.getAttr("src");
      if (typeof src === "string" && src.length > 0) {
        result.push({ name: node.name(), src });
      }
    }
  }
  return result;
}
function exportDocumentJson(document) {
  if (document.schemaVersion !== SCENE_SCHEMA_VERSION) {
    throw new Error(
      `exportDocumentJson: document schemaVersion is ${document.schemaVersion}, expected ${SCENE_SCHEMA_VERSION} \u2014 upgrade the document before exporting`
    );
  }
  return JSON.stringify(document, null, 2);
}
function downloadDataUrl(dataUrl, filename) {
  if (typeof globalThis.document === "undefined") return;
  const a = globalThis.document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.style.display = "none";
  globalThis.document.body.appendChild(a);
  a.click();
  globalThis.document.body.removeChild(a);
}

// src/design-canvas-react/components/CanvasEmptyState.tsx
import { jsx, jsxs } from "react/jsx-runtime";
function SparkleGlyph({ className }) {
  return /* @__PURE__ */ jsx("svg", { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, children: /* @__PURE__ */ jsx("path", { d: "M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1M7.7 16.3l-2.1 2.1" }) });
}
function CanvasEmptyState({
  onStartTemplate,
  onAddElement,
  onAskAgent,
  title = "Start your design",
  subtitle = "Drop in a template, add an element by hand, or let the agent draft it for you.",
  className
}) {
  const doors = [
    {
      key: "template",
      label: "Start with a template",
      hint: "A headline, shape, or block to build on",
      Icon: ShapesGlyph,
      onClick: onStartTemplate
    },
    {
      key: "element",
      label: "Add an element",
      hint: "Place text on the page and edit it",
      Icon: PlusGlyph,
      onClick: onAddElement
    }
  ];
  if (onAskAgent) {
    doors.push({
      key: "agent",
      label: "Ask the agent",
      hint: "Describe what you want made",
      Icon: SparkleGlyph,
      onClick: onAskAgent
    });
  }
  return (
    // Overlay is non-interactive so empty-space clicks reach the canvas; the
    // centered card re-enables pointer events for its own controls.
    /* @__PURE__ */ jsx(
      "div",
      {
        className: `pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-4 ${className ?? ""}`,
        role: "group",
        "aria-label": "Start your design",
        children: /* @__PURE__ */ jsxs("div", { className: "pointer-events-auto flex w-full max-w-lg flex-col items-center gap-5 rounded-xl border border-[var(--card-edge)] bg-[hsl(var(--popover))] px-6 py-7 text-center shadow-[var(--shadow-overlay)] sm:px-8", children: [
          /* @__PURE__ */ jsxs("span", { className: "flex items-center gap-2 text-[var(--text-muted)]", children: [
            /* @__PURE__ */ jsx(BrandKnot, { size: 22, className: "shrink-0" }),
            /* @__PURE__ */ jsx("span", { className: "text-xs font-semibold uppercase tracking-[0.05em]", children: "Tangle Design" })
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-1.5", children: [
            /* @__PURE__ */ jsx("h2", { className: "text-xl font-semibold text-[var(--text-primary)]", children: title }),
            /* @__PURE__ */ jsx("p", { className: "text-sm leading-5 text-[var(--text-secondary)]", children: subtitle })
          ] }),
          /* @__PURE__ */ jsx("div", { className: "grid w-full gap-2 sm:grid-cols-3", children: doors.map(({ key, label, hint, Icon, onClick }) => /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              onClick,
              className: "group flex min-h-[44px] flex-col items-center gap-2 rounded-lg border border-[var(--border-default)] bg-[hsl(var(--card))] px-3 py-4 text-center transition-colors hover:border-[var(--brand-primary)]",
              children: [
                /* @__PURE__ */ jsx("span", { className: "flex h-9 w-9 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] text-[var(--brand-primary)] transition-colors group-hover:bg-[color-mix(in_srgb,var(--brand-primary)_15%,transparent)]", children: /* @__PURE__ */ jsx(Icon, { className: "h-4 w-4" }) }),
                /* @__PURE__ */ jsx("span", { className: "text-sm font-medium text-[var(--text-primary)]", children: label }),
                /* @__PURE__ */ jsx("span", { className: "text-xs leading-4 text-[var(--text-muted)]", children: hint })
              ]
            },
            key
          )) })
        ] })
      }
    )
  );
}

// src/design-canvas-react/components/ElementNode.tsx
import { memo, useEffect, useRef, useState } from "react";
import { Group, Rect, Ellipse, Line, Text, Image as KonvaImage } from "react-konva";

// src/design-canvas-react/components/transform-math.ts
function bakeRectTransform(node) {
  return {
    x: node.x,
    y: node.y,
    width: Math.abs(node.width * node.scaleX),
    height: Math.abs(node.height * node.scaleY),
    rotation: node.rotation
  };
}
function bakeLineTransform(node) {
  const points = node.points.map((v, i) => i % 2 === 0 ? v * node.scaleX : v * node.scaleY);
  return {
    x: node.x,
    y: node.y,
    // Width/height for a line derive from its points; baking is for points only.
    // We still return them so callers have a uniform shape.
    width: node.width * Math.abs(node.scaleX),
    height: node.height * Math.abs(node.scaleY),
    rotation: node.rotation,
    points
  };
}
function bakeTextTransform(node) {
  return {
    x: node.x,
    y: node.y,
    width: Math.abs(node.width * node.scaleX),
    // Height is excluded — it re-derives from content.
    height: node.height,
    rotation: node.rotation,
    fontSize: Math.max(1, node.fontSize * Math.abs(node.scaleY))
  };
}
function ellipseCenterFromTopLeft(topLeft) {
  return {
    x: topLeft.x + topLeft.width / 2,
    y: topLeft.y + topLeft.height / 2,
    radiusX: topLeft.width / 2,
    radiusY: topLeft.height / 2
  };
}
function ellipseTopLeftFromCenter(center) {
  return {
    x: center.x - center.radiusX,
    y: center.y - center.radiusY,
    width: center.radiusX * 2,
    height: center.radiusY * 2
  };
}
function normalizeMarquee(startX, startY, endX, endY) {
  const x = Math.min(startX, endX);
  const y = Math.min(startY, endY);
  return {
    x,
    y,
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY)
  };
}
function computeTextOverlayPosition(input) {
  const left = input.panX + input.elementX * input.zoom;
  const top = input.panY + input.elementY * input.zoom;
  return {
    left,
    top,
    width: input.elementWidth * input.zoom,
    fontSize: input.elementFontSize * input.zoom
  };
}
var SNAP_ANGLES_DEG = [0, 45, 90, 135, 180, 225, 270, 315, 360];
function snapRotation(angleDeg, thresholdDeg = 5) {
  const normalized = (angleDeg % 360 + 360) % 360;
  let best = normalized;
  let bestDist = Infinity;
  for (const snap of SNAP_ANGLES_DEG) {
    const dist = Math.abs(normalized - snap);
    if (dist < bestDist) {
      bestDist = dist;
      best = snap % 360;
    }
  }
  return bestDist <= thresholdDeg ? best : normalized;
}
function nudgeDelta(key, shift) {
  const step = shift ? 10 : 1;
  switch (key) {
    case "ArrowLeft":
      return { dx: -step, dy: 0 };
    case "ArrowRight":
      return { dx: step, dy: 0 };
    case "ArrowUp":
      return { dx: 0, dy: -step };
    case "ArrowDown":
      return { dx: 0, dy: step };
  }
}
function gridVisible(gridSize, zoom, minScreenPx = 4) {
  return gridSize * zoom >= minScreenPx;
}

// src/design-canvas-react/components/ElementNode.tsx
import { jsx as jsx2 } from "react/jsx-runtime";
var IMAGE_CACHE_MAX = 256;
var imageCache = /* @__PURE__ */ new Map();
function imageCacheSet(src, img) {
  if (imageCache.size >= IMAGE_CACHE_MAX) {
    const oldest = imageCache.keys().next().value;
    if (oldest !== void 0) imageCache.delete(oldest);
  }
  imageCache.set(src, img);
}
function useImage(src) {
  const [, setVersion] = useState(0);
  useEffect(() => {
    if (imageCache.has(src)) return;
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imageCacheSet(src, img);
      setVersion((v) => v + 1);
    };
    img.onerror = () => {
      imageCacheSet(src, img);
      setVersion((v) => v + 1);
    };
    img.src = src;
  }, [src]);
  return imageCache.get(src) ?? null;
}
function ElementNodeImpl(props) {
  const { element } = props;
  if (!element.visible) return null;
  switch (element.kind) {
    case "rect":
      return /* @__PURE__ */ jsx2(RectNode, { ...props, element });
    case "ellipse":
      return /* @__PURE__ */ jsx2(EllipseNode, { ...props, element });
    case "line":
      return /* @__PURE__ */ jsx2(LineNode, { ...props, element });
    case "text":
      return /* @__PURE__ */ jsx2(TextNode, { ...props, element });
    case "image":
      return /* @__PURE__ */ jsx2(ImageNode, { ...props, element });
    case "video":
      return /* @__PURE__ */ jsx2(VideoNode, { ...props, element });
    case "group":
      return /* @__PURE__ */ jsx2(GroupNode, { ...props, element });
  }
}
var ElementNode = memo(ElementNodeImpl);
function useDragBindings(props, originX, originY) {
  const { element, onClick, onDragStart, onDragMove, onDragEnd, onDoubleClick } = props;
  const isDraggable = !element.locked && !!onDragEnd;
  const originRef = useRef({ x: originX, y: originY });
  originRef.current = { x: originX, y: originY };
  const [dragging, setDragging] = useState(false);
  return {
    draggable: isDraggable,
    // locked elements still receive click for selection; listening must be true.
    listening: true,
    dragging,
    onDragStart: isDraggable ? () => {
      setDragging(true);
      onDragStart?.(element.id);
    } : void 0,
    onDragMove: isDraggable ? (e) => {
      onDragMove?.(element.id, e.target.x() - originRef.current.x, e.target.y() - originRef.current.y);
    } : void 0,
    onDragEnd: isDraggable ? (e) => {
      setDragging(false);
      onDragEnd?.(element.id, e.target.x(), e.target.y());
    } : void 0,
    onClick: () => onClick?.(element.id),
    onDblClick: () => onDoubleClick?.(element.id)
  };
}
function useNodeCache(ref, isSelected, dragging, zoom, invalidateKey) {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (isSelected || dragging) {
      node.clearCache();
      return;
    }
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    node.cache({ pixelRatio: resolveNodeCachePixelRatio(zoom, dpr) });
    return () => {
      node.clearCache();
    };
  }, [ref, isSelected, dragging, zoom, invalidateKey]);
}
function RectNode({ element, ...rest }) {
  const { dragging, ...drag } = useDragBindings({ element, ...rest }, element.x, element.y);
  const ref = useRef(null);
  useNodeCache(ref, rest.isSelected, dragging, rest.zoom, element);
  return /* @__PURE__ */ jsx2(
    Rect,
    {
      ref,
      name: element.id,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      rotation: element.rotation,
      opacity: element.opacity,
      fill: element.fill,
      stroke: element.stroke,
      strokeWidth: element.strokeWidth,
      cornerRadius: element.cornerRadius ?? 0,
      ...drag
    }
  );
}
function EllipseNode({ element, ...rest }) {
  const { x: cx, y: cy, radiusX, radiusY } = ellipseCenterFromTopLeft(element);
  const { dragging, ...drag } = useDragBindings({ element, ...rest }, element.x, element.y);
  const ref = useRef(null);
  useNodeCache(ref, rest.isSelected, dragging, rest.zoom, element);
  return /* @__PURE__ */ jsx2(
    Ellipse,
    {
      ref,
      name: element.id,
      x: cx,
      y: cy,
      radiusX,
      radiusY,
      rotation: element.rotation,
      opacity: element.opacity,
      fill: element.fill,
      stroke: element.stroke,
      strokeWidth: element.strokeWidth,
      ...drag
    }
  );
}
function LineNode({ element, ...rest }) {
  const { dragging, ...drag } = useDragBindings({ element, ...rest }, element.x, element.y);
  const ref = useRef(null);
  useNodeCache(ref, rest.isSelected, dragging, rest.zoom, element);
  return /* @__PURE__ */ jsx2(
    Line,
    {
      ref,
      name: element.id,
      x: element.x,
      y: element.y,
      points: element.points,
      rotation: element.rotation,
      opacity: element.opacity,
      stroke: element.stroke,
      strokeWidth: element.strokeWidth,
      dash: element.dash,
      ...drag
    }
  );
}
var FONT_STYLE_MAP = {
  "normal": { fontStyle: "normal", fontVariant: "normal", fontWeight: "normal" },
  "bold": { fontStyle: "normal", fontVariant: "normal", fontWeight: "bold" },
  "italic": { fontStyle: "italic", fontVariant: "normal", fontWeight: "normal" },
  "bold italic": { fontStyle: "italic", fontVariant: "normal", fontWeight: "bold" }
};
function TextNode({ element, ...rest }) {
  const { dragging, ...drag } = useDragBindings({ element, ...rest }, element.x, element.y);
  const ref = useRef(null);
  useNodeCache(ref, rest.isSelected, dragging, rest.zoom, element);
  const { fontStyle, fontWeight } = FONT_STYLE_MAP[element.fontStyle];
  return /* @__PURE__ */ jsx2(
    Text,
    {
      ref,
      name: element.id,
      x: element.x,
      y: element.y,
      width: element.width,
      rotation: element.rotation,
      opacity: element.opacity,
      text: element.text,
      fontFamily: element.fontFamily,
      fontSize: element.fontSize,
      fontStyle: `${fontStyle} ${fontWeight}`.trim(),
      fill: element.fill,
      align: element.align,
      lineHeight: element.lineHeight,
      letterSpacing: element.letterSpacing,
      ...drag
    }
  );
}
function ImageNode({ element, ...rest }) {
  const render = rest.render ?? lightTheme.canvasRender;
  const img = useImage(element.src);
  const { dragging, ...drag } = useDragBindings({ element, ...rest }, element.x, element.y);
  const ref = useRef(null);
  const imgReady = !!img && img.complete && img.naturalWidth > 0;
  useNodeCache(
    ref,
    rest.isSelected,
    dragging,
    rest.zoom,
    `${imgReady}:${element.src}:${element.width}x${element.height}:${element.fit}`
  );
  if (!img || !img.complete || img.naturalWidth === 0) {
    return /* @__PURE__ */ jsx2(
      Rect,
      {
        ref,
        name: element.id,
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        rotation: element.rotation,
        opacity: element.opacity,
        fill: render.brokenFill,
        stroke: render.brokenStroke,
        strokeWidth: 1,
        ...drag
      }
    );
  }
  let cropProps = {};
  if (element.fit === "cover") {
    const srcAspect = img.naturalWidth / img.naturalHeight;
    const dstAspect = element.width / element.height;
    if (srcAspect > dstAspect) {
      const visibleW = img.naturalHeight * dstAspect;
      cropProps = {
        crop: {
          x: (img.naturalWidth - visibleW) / 2,
          y: 0,
          width: visibleW,
          height: img.naturalHeight
        }
      };
    } else {
      const visibleH = img.naturalWidth / dstAspect;
      cropProps = {
        crop: {
          x: 0,
          y: (img.naturalHeight - visibleH) / 2,
          width: img.naturalWidth,
          height: visibleH
        }
      };
    }
  }
  return /* @__PURE__ */ jsx2(
    KonvaImage,
    {
      ref,
      name: element.id,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      rotation: element.rotation,
      opacity: element.opacity,
      image: img,
      ...cropProps,
      ...drag
    }
  );
}
function VideoNode({ element, ...rest }) {
  const render = rest.render ?? lightTheme.canvasRender;
  const img = useImage(element.posterSrc ?? "");
  const { dragging, ...drag } = useDragBindings({ element, ...rest }, element.x, element.y);
  const ref = useRef(null);
  const posterReady = !!element.posterSrc && !!img && img.complete && img.naturalWidth > 0;
  useNodeCache(
    ref,
    rest.isSelected,
    dragging,
    rest.zoom,
    `${posterReady}:${element.posterSrc ?? ""}:${element.width}x${element.height}`
  );
  if (!element.posterSrc || !img || !img.complete || img.naturalWidth === 0) {
    return /* @__PURE__ */ jsx2(
      Rect,
      {
        ref,
        name: element.id,
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        rotation: element.rotation,
        opacity: element.opacity,
        fill: render.placeholderFill,
        stroke: render.placeholderStroke,
        strokeWidth: 1,
        ...drag
      }
    );
  }
  return /* @__PURE__ */ jsx2(
    KonvaImage,
    {
      ref,
      name: element.id,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      rotation: element.rotation,
      opacity: element.opacity,
      image: img,
      ...drag
    }
  );
}
function GroupNode({ element, ...rest }) {
  const { dragging: _dragging, ...drag } = useDragBindings({ element, ...rest }, element.x, element.y);
  void _dragging;
  return /* @__PURE__ */ jsx2(
    Group,
    {
      name: element.id,
      x: element.x,
      y: element.y,
      rotation: element.rotation,
      opacity: element.opacity,
      ...drag,
      children: element.children.map((child) => /* @__PURE__ */ jsx2(ElementNode, { ...rest, element: child }, child.id))
    }
  );
}

// src/design-canvas-react/components/SelectionLayer.tsx
import { useEffect as useEffect2, useRef as useRef2 } from "react";
import { Layer, Transformer } from "react-konva";
import { jsx as jsx3 } from "react/jsx-runtime";
var MIN_SIZE = 4;
function SelectionLayer({
  stageRef,
  selectedIds,
  selectedElements,
  canWrite,
  onTransformEnd,
  pageId,
  render = lightTheme.canvasRender
}) {
  const trRef = useRef2(null);
  useEffect2(() => {
    const tr = trRef.current;
    const stage = stageRef.current;
    if (!tr || !stage) return;
    const nodes = [];
    for (const id of selectedIds) {
      const node = stage.findOne(`[name="${id}"]`);
      if (node) nodes.push(node);
    }
    tr.nodes(nodes);
    tr.getLayer()?.batchDraw();
  }, [selectedIds, stageRef]);
  function handleTransformEnd() {
    const tr = trRef.current;
    if (!tr) return;
    const nodes = tr.nodes();
    if (nodes.length === 0) return;
    const entries = [];
    for (const node of nodes) {
      const elementId = node.name();
      const element = selectedElements.find((e) => e.id === elementId);
      if (!element) continue;
      const priorAttrs = elementToPriorAttrs(element);
      const finalAttrs = bakeNodeToAttrs(node, element);
      if (!finalAttrs) continue;
      entries.push({ pageId, elementId, attrs: finalAttrs, priorAttrs });
    }
    if (entries.length > 0) onTransformEnd(entries);
  }
  const multiSelect = selectedIds.length > 1;
  return (
    // The Layer must participate in the hit graph (listening) or the Transformer
    // anchors below receive no pointer events and resize/rotate is dead. We scope
    // listening to canWrite so a read-only canvas stays fully click-through.
    // Click-through to elements for selection is preserved: this layer paints
    // only the Transformer, whose anchors are the sole hit targets — empty
    // regions have no shapes, so pointer hits fall through to the content layer.
    // Export exclusion is unaffected: export.ts hides nodes by the 'overlay:'
    // name prefix, not by `listening` (see export-math.isExportHiddenNodeName).
    /* @__PURE__ */ jsx3(Layer, { name: "overlay:selection", listening: canWrite, children: /* @__PURE__ */ jsx3(
      Transformer,
      {
        ref: trRef,
        name: "overlay:transformer",
        keepRatio: multiSelect,
        rotationSnaps: [0, 45, 90, 135, 180, 225, 270, 315],
        rotationSnapTolerance: 5,
        borderStroke: render.selectionStroke,
        anchorStroke: render.selectionStroke,
        anchorFill: render.selectionAnchorFill,
        boundBoxFunc: (oldBox, newBox) => {
          if (newBox.width < MIN_SIZE || newBox.height < MIN_SIZE) return oldBox;
          return newBox;
        },
        listening: canWrite,
        onTransformEnd: canWrite ? handleTransformEnd : void 0
      }
    ) })
  );
}
function elementToPriorAttrs(element) {
  const base = {
    x: element.x,
    y: element.y,
    rotation: element.rotation
  };
  switch (element.kind) {
    case "rect":
    case "image":
    case "video":
      return { ...base, width: element.width, height: element.height };
    case "ellipse":
      return { ...base, width: element.width, height: element.height };
    case "line":
      return { ...base, points: element.points.slice() };
    case "text":
      return { ...base, width: element.width, fontSize: element.fontSize };
    case "group":
      return { ...base, width: void 0, height: void 0 };
  }
}
function bakeNodeToAttrs(node, element) {
  const rawRotation = node.rotation();
  const snappedRotation = snapRotation(rawRotation, 5);
  const baseNode = {
    x: node.x(),
    y: node.y(),
    width: node.width(),
    height: node.height(),
    scaleX: node.scaleX(),
    scaleY: node.scaleY(),
    rotation: snappedRotation
  };
  switch (element.kind) {
    case "rect":
    case "image":
    case "video":
    case "group": {
      const baked = bakeRectTransform(baseNode);
      return {
        x: baked.x,
        y: baked.y,
        width: Math.max(MIN_SIZE, baked.width),
        height: Math.max(MIN_SIZE, baked.height),
        rotation: baked.rotation
      };
    }
    case "ellipse": {
      const baked = bakeRectTransform(baseNode);
      const topLeft = ellipseTopLeftFromCenter({
        x: baked.x,
        y: baked.y,
        // radiusX/radiusY = half of baked width/height
        radiusX: baked.width / 2,
        radiusY: baked.height / 2
      });
      return {
        x: topLeft.x,
        y: topLeft.y,
        width: Math.max(MIN_SIZE, topLeft.width),
        height: Math.max(MIN_SIZE, topLeft.height),
        rotation: baked.rotation
      };
    }
    case "line": {
      const points = node.points();
      const baked = bakeLineTransform({ ...baseNode, points });
      return {
        x: baked.x,
        y: baked.y,
        rotation: baked.rotation,
        points: baked.points
      };
    }
    case "text": {
      const baked = bakeTextTransform({
        ...baseNode,
        fontSize: element.fontSize
      });
      return {
        x: baked.x,
        y: baked.y,
        width: Math.max(MIN_SIZE, baked.width),
        rotation: baked.rotation,
        fontSize: Math.max(1, baked.fontSize)
      };
    }
  }
}

// src/design-canvas-react/components/GridLayer.tsx
import { Layer as Layer2, Group as Group2, Shape } from "react-konva";
import { jsx as jsx4 } from "react/jsx-runtime";
function gridVerticalLines(pageWidth, gridSize) {
  const out = [];
  if (gridSize <= 0) return out;
  for (let x = gridSize; x < pageWidth; x += gridSize) out.push(x);
  return out;
}
function gridHorizontalLines(pageHeight, gridSize) {
  const out = [];
  if (gridSize <= 0) return out;
  for (let y = gridSize; y < pageHeight; y += gridSize) out.push(y);
  return out;
}
function GridLayer({
  pageWidth,
  pageHeight,
  gridSize,
  zoom,
  panX,
  panY,
  color = "#c0c0c0",
  opacity = 0.5
}) {
  if (!gridVisible(gridSize, zoom, 4)) return null;
  const verticals = gridVerticalLines(pageWidth, gridSize);
  const horizontals = gridHorizontalLines(pageHeight, gridSize);
  const sceneFunc = (ctx, shape) => {
    ctx.beginPath();
    for (const x of verticals) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, pageHeight);
    }
    for (const y of horizontals) {
      ctx.moveTo(0, y);
      ctx.lineTo(pageWidth, y);
    }
    ctx.setAttr("strokeStyle", color);
    ctx.setAttr("lineWidth", 1 / zoom);
    ctx.stroke();
    void shape;
  };
  return /* @__PURE__ */ jsx4(Layer2, { name: "overlay:grid", listening: false, children: /* @__PURE__ */ jsx4(Group2, { x: panX, y: panY, scaleX: zoom, scaleY: zoom, children: /* @__PURE__ */ jsx4(
    Shape,
    {
      name: "overlay:grid-shape",
      sceneFunc,
      stroke: color,
      strokeWidth: 1 / zoom,
      opacity,
      listening: false,
      perfectDrawEnabled: false
    }
  ) }) });
}

// src/design-canvas-react/components/SnapGuidesOverlay.tsx
import { Layer as Layer3, Line as Line2 } from "react-konva";
import { jsx as jsx5, jsxs as jsxs2 } from "react/jsx-runtime";
function kindColors(render) {
  return {
    "grid": render.snapGrid,
    "guide": render.snapGuide,
    "page-edge": render.snapPage,
    "page-center": render.snapPage,
    "element-edge": render.snapElement,
    "element-center": render.snapElement
  };
}
function SnapGuidesOverlay({
  pageWidth,
  pageHeight,
  activeVertical,
  activeHorizontal,
  zoom,
  render = lightTheme.canvasRender
}) {
  if (!activeVertical && !activeHorizontal) return null;
  const KIND_COLOR = kindColors(render);
  const strokeWidth = 1 / zoom;
  return /* @__PURE__ */ jsxs2(Layer3, { name: "overlay:snap", listening: false, children: [
    activeVertical && /* @__PURE__ */ jsx5(
      Line2,
      {
        name: "overlay:snap-vertical",
        points: [activeVertical.position, -99999, activeVertical.position, 99999],
        stroke: KIND_COLOR[activeVertical.kind],
        strokeWidth,
        dash: [4 / zoom, 3 / zoom],
        listening: false,
        perfectDrawEnabled: false
      }
    ),
    activeHorizontal && /* @__PURE__ */ jsx5(
      Line2,
      {
        name: "overlay:snap-horizontal",
        points: [-99999, activeHorizontal.position, 99999, activeHorizontal.position],
        stroke: KIND_COLOR[activeHorizontal.kind],
        strokeWidth,
        dash: [4 / zoom, 3 / zoom],
        listening: false,
        perfectDrawEnabled: false
      }
    )
  ] });
}

// src/design-canvas-react/components/InlineTextEditor.tsx
import { useEffect as useEffect3, useRef as useRef3 } from "react";
import { jsx as jsx6 } from "react/jsx-runtime";
function InlineTextEditor({
  element,
  zoom,
  panX,
  panY,
  onCommit,
  onCancel
}) {
  const ref = useRef3(null);
  const pos = computeTextOverlayPosition({
    elementX: element.x,
    elementY: element.y,
    elementWidth: element.width,
    elementHeight: element.fontSize * element.lineHeight * 4,
    // generous initial height
    zoom,
    panX,
    panY,
    elementFontSize: element.fontSize
  });
  useEffect3(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  function handleKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onCommit(ref.current?.value ?? element.text);
    }
  }
  function handleBlur() {
    onCommit(ref.current?.value ?? element.text);
  }
  const fontWeight = element.fontStyle.includes("bold") ? "bold" : "normal";
  const fontStyle = element.fontStyle.includes("italic") ? "italic" : "normal";
  return /* @__PURE__ */ jsx6(
    "textarea",
    {
      ref,
      defaultValue: element.text,
      onKeyDown: handleKeyDown,
      onBlur: handleBlur,
      className: "agent-app-edit-selection",
      style: {
        position: "absolute",
        left: pos.left,
        top: pos.top,
        width: pos.width,
        // Height auto-grows via CSS; min so single-line text has room.
        minHeight: pos.fontSize * element.lineHeight * 1.5,
        fontSize: pos.fontSize,
        fontFamily: element.fontFamily,
        fontWeight,
        fontStyle,
        textAlign: element.align,
        lineHeight: element.lineHeight,
        letterSpacing: element.letterSpacing * zoom,
        color: element.fill,
        // Neutral token surface rather than a forced white: a white fill makes
        // light text invisible while editing. The token surface stays legible
        // for any text color and matches the editor chrome.
        background: "var(--bg-input)",
        border: "2px solid var(--brand-primary)",
        borderRadius: 2,
        padding: 2,
        resize: "none",
        outline: "none",
        overflow: "hidden",
        boxSizing: "border-box",
        zIndex: 1e3
        // Do NOT apply rotation — see V1 simplification note in module header.
      },
      "aria-label": `Editing text element "${element.name}"`
    }
  );
}

// src/design-canvas-react/components/Workspace.tsx
import { jsx as jsx7, jsxs as jsxs3 } from "react/jsx-runtime";
var SNAP_THRESHOLD_SCREEN_PX = 8;
var DUPLICATE_OFFSET = 10;
var ZOOM_FACTOR_WHEEL = 0.998;
var ZOOM_MIN = 0.05;
var ZOOM_MAX = 32;
var NO_MARQUEE = { active: false, startDocX: 0, startDocY: 0, endDocX: 0, endDocY: 0 };
function WorkspaceView({
  canWrite,
  onApplyOperations,
  onSelectionChange,
  className,
  stack,
  activePage,
  onFitRef,
  onExport,
  onExportRef,
  fitOnMount = true,
  onReady,
  render = lightTheme.canvasRender,
  showEmptyState = true,
  onAskAgent
}) {
  const [, setTick] = useState2(0);
  const forceRender = useCallback(() => setTick((t) => t + 1), []);
  useEffect4(() => stack.subscribe(forceRender), [stack, forceRender]);
  const state = stack.getState();
  const { document, activePageId, selectedElementIds, zoom, panX, panY, gridEnabled, gridSize, snapEnabled, showBleed } = state;
  const zoomPanMath = useMemo(() => createZoomPanMath({ minZoom: ZOOM_MIN, maxZoom: ZOOM_MAX }), []);
  const snapEngine = useMemo(() => createSnapEngine(), []);
  const containerRef = useRef4(null);
  const [containerSize, setContainerSize] = useState2({ width: 800, height: 600 });
  const autoFitRef = useRef4(true);
  const lastAutoFitRef = useRef4(null);
  const readyRef = useRef4(false);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setContainerSize({ width, height });
      if (width <= 0 || height <= 0) return;
      const view = stack.getState();
      const last = lastAutoFitRef.current;
      if (last && (view.zoom !== last.zoom || view.panX !== last.panX || view.panY !== last.panY)) {
        autoFitRef.current = false;
      }
      if (autoFitRef.current && fitOnMount && activePage.width > 0 && activePage.height > 0 && (!last || last.width !== width || last.height !== height)) {
        const fit = zoomPanMath.fitPage(activePage, { width, height });
        stack.setView(fit);
        lastAutoFitRef.current = { ...fit, width, height };
      }
      if (!readyRef.current) {
        readyRef.current = true;
        onReady?.();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [activePage, fitOnMount, onReady, stack, zoomPanMath]);
  const stageRef = useRef4(null);
  useEffect4(() => {
    if (!onFitRef) return;
    onFitRef.current = () => {
      const { width, height } = containerSize;
      if (width <= 0 || height <= 0) return;
      const view = zoomPanMath.fitPage(activePage, { width, height });
      stack.setView(view);
    };
    return () => {
      if (onFitRef.current !== null) onFitRef.current = null;
    };
  });
  useEffect4(() => {
    if (!onExportRef || !onExport) return;
    onExportRef.current = ({ format, pixelRatio }) => {
      const stage = stageRef.current;
      if (!stage) return;
      void (async () => {
        const dataUrl = await exportPageDataUrl(stage, activePage, { format, pixelRatio });
        await onExport({ pageId: activePageId, format, dataUrl, pixelRatio });
      })();
    };
    return () => {
      if (onExportRef.current !== null) onExportRef.current = null;
    };
  });
  const gestureRef = useRef4("idle");
  const panOriginRef = useRef4({ screenX: 0, screenY: 0, panX: 0, panY: 0 });
  const [marquee, setMarquee] = useState2(NO_MARQUEE);
  const marqueeRef = useRef4(NO_MARQUEE);
  const spaceHeldRef = useRef4(false);
  const dragOriginRef = useRef4(/* @__PURE__ */ new Map());
  const [activeSnap, setActiveSnap] = useState2(null);
  const [editingElementId, setEditingElementId] = useState2(null);
  const editingPreRef = useRef4("");
  const nudgeHeldRef = useRef4(null);
  async function persist(command) {
    if (!canWrite) return;
    stack.execute(command);
    try {
      const result = await onApplyOperations(command.operations());
      if (result.document) stack.reset(result.document);
    } catch {
      stack.rollback(command);
    }
  }
  function handleWheel(e) {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const factor = Math.pow(ZOOM_FACTOR_WHEEL, e.deltaY);
    const next = zoomPanMath.zoomAtPoint({ zoom, panX, panY }, factor, screenX, screenY);
    stack.setView(next);
  }
  function handlePointerDown(e) {
    if (e.button === 1 || spaceHeldRef.current) {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      gestureRef.current = "pan";
      panOriginRef.current = { screenX: e.clientX, screenY: e.clientY, panX, panY };
      return;
    }
    if (e.button !== 0) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const docPos = zoomPanMath.screenToDocument({ zoom, panX, panY }, screenX, screenY);
    if (hitTestPoint(activePage, docPos.x, docPos.y) !== null) {
      return;
    }
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    gestureRef.current = "marquee";
    const m = { active: true, startDocX: docPos.x, startDocY: docPos.y, endDocX: docPos.x, endDocY: docPos.y };
    marqueeRef.current = m;
    setMarquee(m);
    stack.setView({ selectedElementIds: [] });
  }
  function handlePointerMove(e) {
    const mode = gestureRef.current;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (mode === "pan") {
      const dx = e.clientX - panOriginRef.current.screenX;
      const dy = e.clientY - panOriginRef.current.screenY;
      stack.setView({ panX: panOriginRef.current.panX + dx, panY: panOriginRef.current.panY + dy });
      return;
    }
    if (mode === "marquee") {
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const docPos = zoomPanMath.screenToDocument({ zoom, panX, panY }, screenX, screenY);
      const m = { ...marqueeRef.current, active: true, endDocX: docPos.x, endDocY: docPos.y };
      marqueeRef.current = m;
      setMarquee(m);
      const normalized = normalizeMarquee(m.startDocX, m.startDocY, m.endDocX, m.endDocY);
      const ids = marqueeSelect(activePage, normalized);
      stack.setView({ selectedElementIds: ids });
    }
  }
  function handlePointerUp(e) {
    gestureRef.current = "idle";
    setMarquee(NO_MARQUEE);
    marqueeRef.current = NO_MARQUEE;
    setActiveSnap(null);
    e.currentTarget.releasePointerCapture(e.pointerId);
  }
  function handleElementDragStart(elementId) {
    if (!canWrite) return;
    const ids = selectedElementIds.includes(elementId) ? selectedElementIds : [elementId];
    const origins = /* @__PURE__ */ new Map();
    for (const id of ids) {
      const found = findElement(activePage, id);
      if (found) {
        const aabb = elementAabb(found.element);
        origins.set(id, { x: found.element.x, y: found.element.y, width: aabb.width, height: aabb.height });
      }
    }
    dragOriginRef.current = origins;
    gestureRef.current = "drag";
    if (!selectedElementIds.includes(elementId)) {
      stack.setView({ selectedElementIds: [elementId] });
    }
  }
  function handleElementDragMove(elementId, dx, dy) {
    if (!canWrite) return;
    const origin = dragOriginRef.current.get(elementId);
    if (!origin) return;
    const dragging = selectedElementIds.includes(elementId) ? selectedElementIds : [elementId];
    const proposedX = origin.x + dx;
    const proposedY = origin.y + dy;
    const snapBounds = { x: proposedX, y: proposedY, width: origin.width, height: origin.height };
    if (snapEnabled) {
      const targets = snapEngine.collectTargets(state, dragging);
      if (gridEnabled) {
        const thresholdDoc = SNAP_THRESHOLD_SCREEN_PX / zoom;
        const gt = collectGridTargets(snapBounds, gridSize, activePage, thresholdDoc);
        targets.vertical.push(...gt.vertical);
        targets.horizontal.push(...gt.horizontal);
      }
      const snapResult = snapEngine.apply(snapBounds, targets, SNAP_THRESHOLD_SCREEN_PX, zoom);
      setActiveSnap(snapResult);
    }
  }
  async function handleElementDragEnd(elementId, finalX, finalY) {
    if (!canWrite) return;
    gestureRef.current = "idle";
    setActiveSnap(null);
    const origin = dragOriginRef.current.get(elementId);
    if (!origin) return;
    const draggingIds = selectedElementIds.includes(elementId) ? selectedElementIds : [elementId];
    let snappedX = finalX;
    let snappedY = finalY;
    if (snapEnabled) {
      const snapBounds = { x: finalX, y: finalY, width: origin.width, height: origin.height };
      const targets = snapEngine.collectTargets(state, draggingIds);
      if (gridEnabled) {
        const thresholdDoc = SNAP_THRESHOLD_SCREEN_PX / zoom;
        const gt = collectGridTargets(snapBounds, gridSize, activePage, thresholdDoc);
        targets.vertical.push(...gt.vertical);
        targets.horizontal.push(...gt.horizontal);
      }
      const snapResult = snapEngine.apply(snapBounds, targets, SNAP_THRESHOLD_SCREEN_PX, zoom);
      snappedX = snapResult.x;
      snappedY = snapResult.y;
    }
    const dx = snappedX - origin.x;
    const dy = snappedY - origin.y;
    if (draggingIds.length === 1) {
      const el = findElement(activePage, elementId)?.element;
      if (!el) return;
      await persist(
        setAttrsCommand({
          pageId: activePageId,
          elementId,
          attrs: { x: snappedX, y: snappedY },
          priorAttrs: { x: el.x, y: el.y }
        })
      );
    } else {
      const entries = [];
      for (const id of draggingIds) {
        const el = findElement(activePage, id)?.element;
        const orig = dragOriginRef.current.get(id);
        if (!el || !orig) continue;
        entries.push({
          pageId: activePageId,
          elementId: id,
          attrs: { x: orig.x + dx, y: orig.y + dy },
          priorAttrs: { x: orig.x, y: orig.y }
        });
      }
      if (entries.length > 0) await persist(multiSetAttrsCommand(entries));
    }
    dragOriginRef.current = /* @__PURE__ */ new Map();
  }
  function handleElementClick(elementId) {
    stack.setView({ selectedElementIds: [elementId] });
  }
  function handleElementDoubleClick(elementId) {
    if (!canWrite) return;
    const found = findElement(activePage, elementId);
    if (!found || found.element.kind !== "text") return;
    editingPreRef.current = found.element.text;
    setEditingElementId(elementId);
  }
  async function handleTextCommit(text) {
    const id = editingElementId;
    setEditingElementId(null);
    if (!id || !canWrite) return;
    const found = findElement(activePage, id);
    if (!found || found.element.kind !== "text") return;
    if (text === editingPreRef.current) return;
    await persist(
      setAttrsCommand({
        pageId: activePageId,
        elementId: id,
        attrs: { text },
        priorAttrs: { text: editingPreRef.current }
      })
    );
  }
  function handleTextCancel() {
    setEditingElementId(null);
  }
  async function handleTransformEnd(entries) {
    if (!canWrite || entries.length === 0) return;
    await persist(multiSetAttrsCommand(entries));
  }
  async function handleStartTemplate() {
    if (!canWrite) return;
    const template = DEFAULT_INSERT_TEMPLATES[0];
    if (!template) return;
    const ops = template.build({
      pageId: activePageId,
      width: activePage.width,
      height: activePage.height,
      background: activePage.background
    });
    const addedIds = [];
    for (const op of ops) {
      if (op.type === "add_element") {
        await persist(addElementCommand({ pageId: op.pageId, element: op.element }));
        addedIds.push(op.element.id);
      }
    }
    if (addedIds.length > 0) stack.setView({ selectedElementIds: addedIds });
  }
  async function handleAddElement() {
    if (!canWrite) return;
    const width = Math.min(420, Math.round(activePage.width * 0.6)) || 320;
    const element = {
      id: crypto.randomUUID(),
      kind: "text",
      name: "Text",
      x: Math.max(0, Math.round((activePage.width - width) / 2)),
      y: Math.max(0, Math.round(activePage.height / 2 - 24)),
      rotation: 0,
      opacity: 1,
      locked: false,
      visible: true,
      width,
      text: "Double-click to edit",
      fontFamily: "Inter",
      fontSize: 32,
      fontStyle: "normal",
      fill: "#111827",
      align: "left",
      lineHeight: 1.2,
      letterSpacing: 0
    };
    await persist(addElementCommand({ pageId: activePageId, element }));
    stack.setView({ selectedElementIds: [element.id] });
  }
  function handleKeyDown(e) {
    if (e.key === " ") {
      e.preventDefault();
      spaceHeldRef.current = true;
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape") {
      e.preventDefault();
      if (gestureRef.current !== "idle") {
        gestureRef.current = "idle";
        setMarquee(NO_MARQUEE);
        setActiveSnap(null);
      } else if (editingElementId) {
        setEditingElementId(null);
      } else {
        stack.setView({ selectedElementIds: [] });
      }
      return;
    }
    if (editingElementId) return;
    if ((e.key === "Delete" || e.key === "Backspace") && selectedElementIds.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      for (const id of [...selectedElementIds]) {
        try {
          persist(deleteElementCommand({ document, pageId: activePageId, elementId: id }));
        } catch {
        }
      }
      stack.setView({ selectedElementIds: [] });
      return;
    }
    if (mod && e.key === "z" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (stack.canUndo()) stack.undo();
      return;
    }
    if (mod && (e.key === "z" && e.shiftKey || e.key === "y")) {
      e.preventDefault();
      e.stopPropagation();
      if (stack.canRedo()) stack.redo();
      return;
    }
    if (mod && e.key === "a") {
      e.preventDefault();
      const ids = activePage.elements.filter((el) => !el.locked && el.visible).map((el) => el.id);
      stack.setView({ selectedElementIds: ids });
      return;
    }
    if (mod && e.key === "d" && selectedElementIds.length > 0) {
      e.preventDefault();
      for (const id of selectedElementIds) {
        const found = findElement(activePage, id);
        if (!found) continue;
        const clone = {
          ...structuredClone(found.element),
          id: crypto.randomUUID(),
          x: found.element.x + DUPLICATE_OFFSET,
          y: found.element.y + DUPLICATE_OFFSET
        };
        persist(addElementCommand({ pageId: activePageId, element: clone }));
      }
      return;
    }
    if (mod && !e.shiftKey && e.key === "g" && selectedElementIds.length >= 2) {
      e.preventDefault();
      persist(groupElementsCommand({
        document,
        pageId: activePageId,
        elementIds: selectedElementIds,
        groupId: crypto.randomUUID()
      }));
      return;
    }
    if (mod && e.shiftKey && e.key === "g" && selectedElementIds.length === 1) {
      e.preventDefault();
      const id = selectedElementIds[0];
      persist(ungroupElementCommand({ document, pageId: activePageId, groupId: id }));
      return;
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) && selectedElementIds.length > 0) {
      e.preventDefault();
      const key = e.key;
      if (nudgeHeldRef.current && nudgeHeldRef.current.key !== key) {
        flushNudge();
      }
      if (!nudgeHeldRef.current) {
        const origins = /* @__PURE__ */ new Map();
        for (const id of selectedElementIds) {
          const found = findElement(activePage, id);
          if (found) origins.set(id, { x: found.element.x, y: found.element.y });
        }
        nudgeHeldRef.current = { key, ids: selectedElementIds.slice(), origin: origins };
      }
      const { dx, dy } = nudgeDelta(key, e.shiftKey);
      const entries = [];
      for (const [id, orig] of nudgeHeldRef.current.origin) {
        const found = findElement(activePage, id);
        if (!found) continue;
        entries.push({
          pageId: activePageId,
          elementId: id,
          attrs: { x: found.element.x + dx, y: found.element.y + dy },
          priorAttrs: { x: found.element.x, y: found.element.y }
        });
      }
      if (entries.length > 0) {
        stack.execute(multiSetAttrsCommand(entries));
      }
    }
  }
  function handleKeyUp(e) {
    if (e.key === " ") {
      spaceHeldRef.current = false;
      return;
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      flushNudge();
    }
  }
  function flushNudge() {
    const held = nudgeHeldRef.current;
    if (!held) return;
    nudgeHeldRef.current = null;
    if (!canWrite || held.ids.length === 0) return;
    const entries = [];
    for (const id of held.ids) {
      const orig = held.origin.get(id);
      const found = findElement(activePage, id);
      if (!orig || !found) continue;
      entries.push({
        pageId: activePageId,
        elementId: id,
        attrs: { x: found.element.x, y: found.element.y },
        priorAttrs: { x: orig.x, y: orig.y }
      });
    }
    if (entries.length > 0) {
      onApplyOperations(multiSetAttrsCommand(entries).operations()).catch(() => {
        for (const [id, orig] of held.origin) {
          const found = findElement(activePage, id);
          if (!found) continue;
          persist(setAttrsCommand({
            pageId: activePageId,
            elementId: id,
            attrs: { x: orig.x, y: orig.y },
            priorAttrs: { x: found.element.x, y: found.element.y }
          }));
        }
      });
    }
  }
  useEffect4(() => {
    if (!onSelectionChange) return;
    const elements = selectedElementIds.map((id) => findElement(activePage, id)?.element).filter((el) => !!el);
    onSelectionChange(elements);
  }, [selectedElementIds, activePage, onSelectionChange]);
  const selectedElements = useMemo(
    () => selectedElementIds.map((id) => findElement(activePage, id)?.element).filter((el) => !!el),
    [selectedElementIds, activePage]
  );
  const editingTextElement = editingElementId ? findElement(activePage, editingElementId)?.element ?? null : null;
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
  const pageScreenX = panX;
  const pageScreenY = panY;
  const pageScreenW = activePage.width * zoom;
  const pageScreenH = activePage.height * zoom;
  const activeVerticalGuide = activeSnap?.activeVertical ?? null;
  const activeHorizontalGuide = activeSnap?.activeHorizontal ?? null;
  const normalizedMarquee = marquee.active ? normalizeMarquee(marquee.startDocX, marquee.startDocY, marquee.endDocX, marquee.endDocY) : null;
  const handlerImplRef = useRef4({
    onClick: handleElementClick,
    onDragStart: handleElementDragStart,
    onDragMove: handleElementDragMove,
    onDragEnd: handleElementDragEnd,
    onDoubleClick: handleElementDoubleClick
  });
  handlerImplRef.current = {
    onClick: handleElementClick,
    onDragStart: handleElementDragStart,
    onDragMove: handleElementDragMove,
    onDragEnd: handleElementDragEnd,
    onDoubleClick: handleElementDoubleClick
  };
  const onElementClick = useCallback((id) => handlerImplRef.current.onClick(id), []);
  const onElementDragStart = useCallback((id) => handlerImplRef.current.onDragStart(id), []);
  const onElementDragMove = useCallback(
    (id, dx, dy) => handlerImplRef.current.onDragMove(id, dx, dy),
    []
  );
  const onElementDragEnd = useCallback(
    (id, x, y) => handlerImplRef.current.onDragEnd(id, x, y),
    []
  );
  const onElementDoubleClick = useCallback((id) => handlerImplRef.current.onDoubleClick(id), []);
  const visibleElements = useMemo(() => {
    const pageRect = { x: 0, y: 0, width: activePage.width, height: activePage.height };
    const pinned = new Set(selectedElementIds);
    if (editingElementId) pinned.add(editingElementId);
    return activePage.elements.filter(
      (el) => pinned.has(el.id) || boundsIntersect(elementAabb(el), pageRect)
    );
  }, [activePage.elements, activePage.width, activePage.height, selectedElementIds, editingElementId]);
  return /* @__PURE__ */ jsxs3(
    "div",
    {
      className: `design-canvas-workspace relative h-full w-full overflow-hidden bg-[var(--canvas-backdrop,#1a1a1a)] focus-visible:[outline-offset:-2px] ${className ?? ""}`,
      ref: containerRef,
      tabIndex: 0,
      onWheel: handleWheel,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onKeyDown: handleKeyDown,
      onKeyUp: handleKeyUp,
      style: { cursor: spaceHeldRef.current ? "grab" : "default", touchAction: "none" },
      children: [
        /* @__PURE__ */ jsxs3(
          Stage,
          {
            ref: stageRef,
            width: containerSize.width,
            height: containerSize.height,
            pixelRatio: dpr,
            listening: true,
            children: [
              gridEnabled && /* @__PURE__ */ jsx7(
                GridLayer,
                {
                  pageWidth: activePage.width,
                  pageHeight: activePage.height,
                  gridSize,
                  zoom,
                  panX,
                  panY,
                  color: render.grid
                }
              ),
              /* @__PURE__ */ jsx7(Layer4, { children: /* @__PURE__ */ jsxs3(Group3, { x: panX, y: panY, scaleX: zoom, scaleY: zoom, children: [
                /* @__PURE__ */ jsx7(
                  Rect2,
                  {
                    name: "page-background",
                    x: 0,
                    y: 0,
                    width: activePage.width,
                    height: activePage.height,
                    fill: activePage.background,
                    shadowColor: "rgba(0,0,0,0.4)",
                    shadowBlur: 24 / zoom,
                    shadowOffset: { x: 0, y: 4 / zoom },
                    listening: false
                  }
                ),
                /* @__PURE__ */ jsx7(
                  Group3,
                  {
                    clipX: 0,
                    clipY: 0,
                    clipWidth: activePage.width,
                    clipHeight: activePage.height,
                    children: visibleElements.map((element) => /* @__PURE__ */ jsx7(
                      ElementNode,
                      {
                        element,
                        isSelected: selectedElementIds.includes(element.id),
                        zoom,
                        render,
                        onClick: onElementClick,
                        onDragStart: onElementDragStart,
                        onDragMove: onElementDragMove,
                        onDragEnd: onElementDragEnd,
                        onDoubleClick: onElementDoubleClick
                      },
                      element.id
                    ))
                  }
                )
              ] }) }),
              (activeVerticalGuide || activeHorizontalGuide) && /* @__PURE__ */ jsx7(Layer4, { children: /* @__PURE__ */ jsx7(Group3, { x: panX, y: panY, scaleX: zoom, scaleY: zoom, children: /* @__PURE__ */ jsx7(
                SnapGuidesOverlay,
                {
                  pageWidth: activePage.width,
                  pageHeight: activePage.height,
                  activeVertical: activeVerticalGuide,
                  activeHorizontal: activeHorizontalGuide,
                  zoom,
                  render
                }
              ) }) }),
              /* @__PURE__ */ jsx7(
                SelectionLayer,
                {
                  stageRef,
                  selectedIds: selectedElementIds,
                  selectedElements,
                  canWrite,
                  onTransformEnd: handleTransformEnd,
                  pageId: activePageId,
                  render
                }
              )
            ]
          }
        ),
        showBleed && activePage.bleed && /* @__PURE__ */ jsx7(
          "div",
          {
            className: "pointer-events-none absolute",
            style: { left: pageScreenX, top: pageScreenY, width: pageScreenW, height: pageScreenH },
            children: /* @__PURE__ */ jsx7(
              BleedTrimOverlay,
              {
                pageWidthPx: pageScreenW,
                pageHeightPx: pageScreenH,
                bleed: {
                  top: activePage.bleed.top * zoom,
                  right: activePage.bleed.right * zoom,
                  bottom: activePage.bleed.bottom * zoom,
                  left: activePage.bleed.left * zoom
                }
              }
            )
          }
        ),
        normalizedMarquee && /* @__PURE__ */ jsx7(
          "div",
          {
            className: "pointer-events-none absolute border",
            style: {
              borderColor: render.selectionStroke,
              backgroundColor: `color-mix(in srgb, ${render.selectionStroke} 10%, transparent)`,
              left: panX + normalizedMarquee.x * zoom,
              top: panY + normalizedMarquee.y * zoom,
              width: normalizedMarquee.width * zoom,
              height: normalizedMarquee.height * zoom
            }
          }
        ),
        editingTextElement && /* @__PURE__ */ jsx7(
          InlineTextEditor,
          {
            element: editingTextElement,
            zoom,
            panX,
            panY,
            onCommit: handleTextCommit,
            onCancel: handleTextCancel
          }
        ),
        showEmptyState && canWrite && activePage.elements.length === 0 && !editingElementId ? /* @__PURE__ */ jsx7(
          CanvasEmptyState,
          {
            onStartTemplate: () => void handleStartTemplate(),
            onAddElement: () => void handleAddElement(),
            onAskAgent
          }
        ) : null
      ]
    }
  );
}
function Workspace(props) {
  const stackRef = useRef4(
    createSceneCommandStack(
      props.document,
      props.document.pages[0]?.id ?? ""
    )
  );
  const [, setTick] = useState2(0);
  const forceRender = useCallback(() => setTick((t) => t + 1), []);
  useEffect4(() => {
    return stackRef.current.subscribe(forceRender);
  }, [forceRender]);
  const prevRevRef = useRef4(props.rev);
  useEffect4(() => {
    if (props.rev !== prevRevRef.current) {
      prevRevRef.current = props.rev;
      stackRef.current.reset(props.document);
    }
  }, [props.rev, props.document]);
  const state = stackRef.current.getState();
  const activePage = state.document.pages.find((p) => p.id === state.activePageId) ?? state.document.pages[0];
  if (!activePage) return null;
  return /* @__PURE__ */ jsx7(
    WorkspaceView,
    {
      stack: stackRef.current,
      activePage,
      canWrite: props.canWrite,
      onApplyOperations: props.onApplyOperations,
      onSelectionChange: props.onSelectionChange,
      className: props.className,
      render: props.render
    }
  );
}

// src/design-canvas-react/components/DesignCanvasEditor.tsx
import { jsx as jsx8 } from "react/jsx-runtime";
var THUMBNAIL_HEIGHT_PX = 96;
var thumbnailCache = /* @__PURE__ */ new Map();
var THUMBNAIL_CACHE_LIMIT = 200;
function evictIfNeeded() {
  if (thumbnailCache.size < THUMBNAIL_CACHE_LIMIT) return;
  const toDrop = Math.floor(THUMBNAIL_CACHE_LIMIT * 0.2);
  let dropped = 0;
  for (const key of thumbnailCache.keys()) {
    if (dropped >= toDrop) break;
    thumbnailCache.delete(key);
    dropped++;
  }
}
function cheapHash(value) {
  const s = JSON.stringify(value) ?? "";
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
async function renderPageThumbnail(page) {
  const cacheKey = `${page.id}:${cheapHash(page.elements)}`;
  const cached = thumbnailCache.get(cacheKey);
  if (cached !== void 0) return cached;
  let Konva;
  try {
    const mod = await import("konva");
    Konva = mod.default;
  } catch {
    return null;
  }
  const aspectRatio = page.width > 0 ? page.width / page.height : 1;
  const thumbH = THUMBNAIL_HEIGHT_PX;
  const thumbW = Math.round(thumbH * aspectRatio);
  const scale = page.height > 0 ? thumbH / page.height : 1;
  let stage = null;
  try {
    const container = globalThis.document?.createElement("div");
    if (!container) return null;
    container.style.position = "absolute";
    container.style.left = "-9999px";
    container.style.top = "-9999px";
    globalThis.document.body.appendChild(container);
    stage = new Konva.Stage({ container, width: thumbW, height: thumbH });
    const layer = new Konva.Layer();
    stage.add(layer);
    layer.add(new Konva.Rect({
      x: 0,
      y: 0,
      width: thumbW,
      height: thumbH,
      fill: page.background,
      listening: false
    }));
    const group = new Konva.Group({ x: 0, y: 0, scaleX: scale, scaleY: scale, listening: false });
    layer.add(group);
    paintElements(Konva, group, page.elements);
    const dataUrl = stage.toDataURL({ mimeType: "image/png", pixelRatio: 1 });
    evictIfNeeded();
    thumbnailCache.set(cacheKey, dataUrl);
    return dataUrl;
  } catch {
    return null;
  } finally {
    if (stage) {
      stage.destroy();
      const el = stage.container();
      el.parentNode?.removeChild(el);
    }
  }
}
function paintElements(Konva, parent, elements) {
  for (const el of elements) {
    if (!el.visible) continue;
    switch (el.kind) {
      case "rect":
        parent.add(new Konva.Rect({
          x: el.x,
          y: el.y,
          width: el.width,
          height: el.height,
          rotation: el.rotation,
          opacity: el.opacity,
          fill: el.fill ?? void 0,
          cornerRadius: el.cornerRadius ?? 0,
          listening: false
        }));
        break;
      case "ellipse":
        parent.add(new Konva.Ellipse({
          x: el.x + el.width / 2,
          y: el.y + el.height / 2,
          radiusX: el.width / 2,
          radiusY: el.height / 2,
          rotation: el.rotation,
          opacity: el.opacity,
          fill: el.fill ?? void 0,
          listening: false
        }));
        break;
      case "text":
        parent.add(new Konva.Text({
          x: el.x,
          y: el.y,
          width: el.width,
          rotation: el.rotation,
          opacity: el.opacity,
          text: el.text,
          fontSize: el.fontSize,
          fontFamily: el.fontFamily,
          fill: el.fill,
          align: el.align,
          listening: false
        }));
        break;
      case "group": {
        const g = new Konva.Group({
          x: el.x,
          y: el.y,
          rotation: el.rotation,
          opacity: el.opacity,
          listening: false
        });
        parent.add(g);
        paintElements(Konva, g, el.children);
        break;
      }
      // image and video: skip — async loading not viable in sync thumbnail render
      default:
        break;
    }
  }
}
function DesignCanvasEditor(props) {
  return /* @__PURE__ */ jsx8(
    DesignCanvas,
    {
      ...props,
      renderWorkspace: (ctx) => {
        if (!ctx.activePage) return null;
        return /* @__PURE__ */ jsx8(
          WorkspaceView,
          {
            stack: ctx.stack,
            activePage: ctx.activePage,
            canWrite: ctx.canWrite,
            onApplyOperations: props.onApplyOperations,
            onSelectionChange: props.onSelectionChange,
            onFitRef: ctx.onFitRef,
            onExport: props.onExport,
            onExportRef: ctx.onExportRef,
            fitOnMount: ctx.fitOnMount,
            onReady: ctx.onReady,
            render: ctx.render,
            showEmptyState: ctx.showEmptyState,
            onAskAgent: ctx.onAskAgent
          }
        );
      },
      renderThumbnail: renderPageThumbnail
    }
  );
}

export {
  exportPageDataUrl,
  exportDocumentJson,
  downloadDataUrl,
  CanvasEmptyState,
  bakeRectTransform,
  bakeLineTransform,
  bakeTextTransform,
  ElementNode,
  SelectionLayer,
  GridLayer,
  WorkspaceView,
  Workspace,
  DesignCanvasEditor
};
//# sourceMappingURL=chunk-G2B23BZ6.js.map