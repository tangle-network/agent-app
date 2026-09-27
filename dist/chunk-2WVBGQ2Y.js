import {
  assertSceneMediaSrc,
  bleedAwareExportBounds,
  boundsIntersect,
  elementAabb,
  scaleForPreset
} from "./chunk-BWQPVS7D.js";

// src/design-canvas-react/engine/snap.ts
var KIND_PRIORITY = {
  "guide": 0,
  "page-edge": 1,
  "page-center": 2,
  "element-edge": 3,
  "element-center": 4,
  "grid": 5
};
function createSnapEngine() {
  return {
    collectTargets(state, excludeIds) {
      const page = state.document.pages.find((p) => p.id === state.activePageId);
      if (!page) throw new Error(`collectTargets: active page ${state.activePageId} not found`);
      const vertical = [];
      const horizontal = [];
      const excludeSet = new Set(excludeIds);
      vertical.push({ position: 0, kind: "page-edge" });
      vertical.push({ position: page.width, kind: "page-edge" });
      vertical.push({ position: page.width / 2, kind: "page-center" });
      horizontal.push({ position: 0, kind: "page-edge" });
      horizontal.push({ position: page.height, kind: "page-edge" });
      horizontal.push({ position: page.height / 2, kind: "page-center" });
      for (const pos of page.guides.vertical) {
        vertical.push({ position: pos, kind: "guide" });
      }
      for (const pos of page.guides.horizontal) {
        horizontal.push({ position: pos, kind: "guide" });
      }
      collectElementTargets(page.elements, excludeSet, vertical, horizontal);
      return { vertical, horizontal };
    },
    apply(bounds, targets, thresholdPx, zoom) {
      if (!Number.isFinite(zoom) || zoom <= 0) {
        throw new Error(`snap.apply: zoom must be a positive finite number, got ${zoom}`);
      }
      if (!Number.isFinite(thresholdPx) || thresholdPx < 0) {
        throw new Error(`snap.apply: thresholdPx must be a non-negative finite number, got ${thresholdPx}`);
      }
      const threshold = thresholdPx / zoom;
      const snappedX = snapAxis(bounds.x, bounds.x + bounds.width / 2, bounds.x + bounds.width, targets.vertical, threshold);
      const snappedY = snapAxis(bounds.y, bounds.y + bounds.height / 2, bounds.y + bounds.height, targets.horizontal, threshold);
      return {
        x: snappedX !== null ? snappedX.docPosition - snappedX.elementOffset : bounds.x,
        y: snappedY !== null ? snappedY.docPosition - snappedY.elementOffset : bounds.y,
        activeVertical: snappedX !== null ? snappedX.target : null,
        activeHorizontal: snappedY !== null ? snappedY.target : null
      };
    }
  };
}
function collectGridTargets(bounds, gridSize, page, thresholdDocPx) {
  if (!Number.isFinite(gridSize) || gridSize <= 0) {
    throw new Error(`collectGridTargets: gridSize must be positive finite, got ${gridSize}`);
  }
  const vertical = [];
  const horizontal = [];
  const xMin = Math.floor((bounds.x - thresholdDocPx) / gridSize) * gridSize;
  const xMax = Math.ceil((bounds.x + bounds.width + thresholdDocPx) / gridSize) * gridSize;
  for (let x = xMin; x <= xMax; x += gridSize) {
    if (x >= 0 && x <= page.width) vertical.push({ position: x, kind: "grid" });
  }
  const yMin = Math.floor((bounds.y - thresholdDocPx) / gridSize) * gridSize;
  const yMax = Math.ceil((bounds.y + bounds.height + thresholdDocPx) / gridSize) * gridSize;
  for (let y = yMin; y <= yMax; y += gridSize) {
    if (y >= 0 && y <= page.height) horizontal.push({ position: y, kind: "grid" });
  }
  return { vertical, horizontal };
}
function snapAxis(start, center, end, targets, threshold) {
  const candidates = [
    { value: start, offset: 0 },
    { value: center, offset: center - start },
    { value: end, offset: end - start }
  ];
  let best = null;
  let bestDistance = Infinity;
  let bestPriority = Infinity;
  for (const { value, offset } of candidates) {
    for (const target of targets) {
      const distance = Math.abs(target.position - value);
      if (distance > threshold) continue;
      const priority = KIND_PRIORITY[target.kind];
      if (distance < bestDistance || distance === bestDistance && priority < bestPriority) {
        bestDistance = distance;
        bestPriority = priority;
        best = { target, docPosition: target.position, elementOffset: offset };
      }
    }
  }
  return best;
}
function collectElementTargets(elements, excludeIds, vertical, horizontal) {
  for (const el of elements) {
    if (!el.visible || el.locked) continue;
    if (excludeIds.has(el.id)) continue;
    const aabb = elementAabb(el);
    vertical.push({ position: aabb.x, kind: "element-edge" });
    vertical.push({ position: aabb.x + aabb.width / 2, kind: "element-center" });
    vertical.push({ position: aabb.x + aabb.width, kind: "element-edge" });
    horizontal.push({ position: aabb.y, kind: "element-edge" });
    horizontal.push({ position: aabb.y + aabb.height / 2, kind: "element-center" });
    horizontal.push({ position: aabb.y + aabb.height, kind: "element-edge" });
    if (el.kind === "group") {
      collectElementTargets(el.children, excludeIds, vertical, horizontal);
    }
  }
}

// src/design-canvas-react/engine/selection.ts
function hitTestPoint(page, x, y) {
  return hitTestIn(page.elements, x, y, null);
}
function hitTestIn(elements, x, y, resolveTo) {
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const el = elements[i];
    if (!el.visible || el.locked) continue;
    const aabb = elementAabb(el);
    if (!pointInBounds(aabb, x, y)) continue;
    if (el.kind === "group") {
      const child = hitTestIn(el.children, x, y, el.id);
      return child ?? el.id;
    }
    return resolveTo ?? el.id;
  }
  return null;
}
function pointInBounds(b, x, y) {
  return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
}
function marqueeSelect(page, rect, opts = {}) {
  assertValidBounds(rect, "marqueeSelect rect");
  const result = [];
  collectMarqueeIds(page.elements, rect, opts.requireFullContainment ?? false, result);
  return result;
}
function collectMarqueeIds(elements, rect, requireContainment, result) {
  for (const el of elements) {
    if (!el.visible || el.locked) continue;
    const aabb = elementAabb(el);
    if (el.kind === "group") {
      if (boundsIntersect(rect, aabb)) {
        collectMarqueeIds(el.children, rect, requireContainment, result);
      }
      continue;
    }
    const hit = requireContainment ? boundsContain(rect, aabb) : boundsIntersect(rect, aabb);
    if (hit) result.push(el.id);
  }
}
function boundsContain(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}
var NUDGE_NORMAL_PX = 1;
var NUDGE_SHIFT_PX = 10;
function nudgeDelta(key, shift) {
  const step = shift ? NUDGE_SHIFT_PX : NUDGE_NORMAL_PX;
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
var DUPLICATE_OFFSET = { dx: 10, dy: 10 };
function assertValidBounds(bounds, label) {
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) {
    throw new Error(`${label}: all fields must be finite numbers`);
  }
}

// src/design-canvas-react/engine/zoom-pan.ts
function createZoomPanMath(config) {
  const { minZoom, maxZoom } = config;
  if (!Number.isFinite(minZoom) || minZoom <= 0) {
    throw new Error(`minZoom must be a positive finite number, got ${minZoom}`);
  }
  if (!Number.isFinite(maxZoom) || maxZoom <= minZoom) {
    throw new Error(`maxZoom must be finite and greater than minZoom (${minZoom}), got ${maxZoom}`);
  }
  return {
    minZoom,
    maxZoom,
    zoomAtPoint(state, factor, screenX, screenY) {
      if (!Number.isFinite(factor) || factor <= 0) {
        throw new Error(`zoomAtPoint: factor must be a positive finite number, got ${factor}`);
      }
      if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) {
        throw new Error(`zoomAtPoint: screenX/screenY must be finite numbers`);
      }
      if (!Number.isFinite(state.zoom) || state.zoom <= 0) {
        throw new Error(`zoomAtPoint: state.zoom must be a positive finite number, got ${state.zoom}`);
      }
      const newZoom = Math.min(maxZoom, Math.max(minZoom, state.zoom * factor));
      const docX = (screenX - state.panX) / state.zoom;
      const docY = (screenY - state.panY) / state.zoom;
      const panX = screenX - docX * newZoom;
      const panY = screenY - docY * newZoom;
      return { zoom: newZoom, panX, panY };
    },
    fitPage(page, viewport, paddingPx = 48) {
      if (!Number.isFinite(page.width) || page.width <= 0) {
        throw new Error(`fitPage: page.width must be a positive finite number, got ${page.width}`);
      }
      if (!Number.isFinite(page.height) || page.height <= 0) {
        throw new Error(`fitPage: page.height must be a positive finite number, got ${page.height}`);
      }
      if (!Number.isFinite(viewport.width) || viewport.width <= 0) {
        throw new Error(`fitPage: viewport.width must be a positive finite number, got ${viewport.width}`);
      }
      if (!Number.isFinite(viewport.height) || viewport.height <= 0) {
        throw new Error(`fitPage: viewport.height must be a positive finite number, got ${viewport.height}`);
      }
      if (!Number.isFinite(paddingPx) || paddingPx < 0) {
        throw new Error(`fitPage: paddingPx must be a non-negative finite number, got ${paddingPx}`);
      }
      const pad = Math.min(paddingPx, Math.min(viewport.width, viewport.height) * 0.2);
      const availW = viewport.width - pad * 2;
      const availH = viewport.height - pad * 2;
      const zoom = Math.min(maxZoom, Math.max(minZoom, Math.min(availW / page.width, availH / page.height)));
      const panX = (viewport.width - page.width * zoom) / 2;
      const panY = (viewport.height - page.height * zoom) / 2;
      return { zoom, panX, panY };
    },
    documentToScreen(state, x, y) {
      return { x: x * state.zoom + state.panX, y: y * state.zoom + state.panY };
    },
    screenToDocument(state, x, y) {
      if (!Number.isFinite(state.zoom) || state.zoom === 0) {
        throw new Error(`screenToDocument: zoom must be a non-zero finite number, got ${state.zoom}`);
      }
      return { x: (x - state.panX) / state.zoom, y: (y - state.panY) / state.zoom };
    }
  };
}

// src/design-canvas-react/export-math.ts
function isExportHiddenNodeName(name) {
  return name.startsWith("overlay:") || name === "Transformer";
}
function resolveExportParams(page, opts) {
  const includeBleed = opts.preset !== void 0 ? opts.preset.includeBleed : opts.includeBleed ?? false;
  const cropRect = bleedAwareExportBounds(page, includeBleed);
  const pixelRatio = opts.preset !== void 0 ? scaleForPreset(opts.preset, cropRect) : opts.pixelRatio ?? 1;
  const format = opts.preset !== void 0 ? opts.preset.format : opts.format;
  const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
  return {
    cropRect,
    pixelRatio,
    mimeType,
    quality: format === "jpeg" ? 0.92 : void 0
  };
}
var NODE_CACHE_PIXEL_RATIO_MAX = 4;
function resolveNodeCachePixelRatio(absoluteScale, devicePixelRatio) {
  return Math.min(absoluteScale * devicePixelRatio, NODE_CACHE_PIXEL_RATIO_MAX);
}
function identifyTaintedSrc(imageSrcs) {
  for (const { src } of imageSrcs) {
    if (isCrossOriginSrc(src)) return src;
  }
  return null;
}
function isCrossOriginSrc(src) {
  return /^https?:\/\//i.test(src);
}
function documentCropToStageCoords(cropRect, stageScale, stageX, stageY) {
  return {
    x: stageX + cropRect.x * stageScale,
    y: stageY + cropRect.y * stageScale,
    width: cropRect.width * stageScale,
    height: cropRect.height * stageScale
  };
}

// src/design-canvas-react/insert-builders.ts
var MAX_INSERT_DIMENSION = 600;
function mintElementId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `el-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function fittedSize(naturalW, naturalH, pageWidth, pageHeight) {
  const cap = Math.min(MAX_INSERT_DIMENSION, pageWidth * 0.8, pageHeight * 0.8);
  const longest = Math.max(naturalW, naturalH);
  const scale = naturalW > 0 && naturalH > 0 ? Math.min(1, cap / longest) : 1;
  const width = Math.max(1, Math.round((naturalW || cap) * scale));
  const height = Math.max(1, Math.round((naturalH || cap) * scale));
  return { width, height };
}
function centeredPosition(width, height, pageWidth, pageHeight) {
  return {
    x: Math.round((pageWidth - width) / 2),
    y: Math.round((pageHeight - height) / 2)
  };
}
function baseAttrs(name, x, y) {
  return { id: mintElementId(), name, x, y, rotation: 0, opacity: 1, locked: false, visible: true };
}
function addElementOp(pageId, element) {
  return { type: "add_element", pageId, element };
}
function hexLuminance(color) {
  if (!color) return null;
  const raw = color.trim();
  const hex = raw.startsWith("#") ? raw.slice(1) : "";
  const full = hex.length === 3 ? hex.split("").map((ch) => ch + ch).join("") : hex.length === 6 ? hex : "";
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const channels = [0, 2, 4].map((start) => parseInt(full.slice(start, start + 2), 16) / 255);
  const [r, g, b] = channels.map((value) => value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function pageTextFill(page, tone) {
  const luminance = hexLuminance(page.background);
  if (luminance !== null && luminance < 0.35) {
    return tone === "primary" ? "#f8fafc" : "#cbd5e1";
  }
  return tone === "primary" ? "#111827" : "#374151";
}
function buildInsertImageOp(src, naturalSize, page) {
  assertSceneMediaSrc(src, "image src");
  const { width, height } = fittedSize(naturalSize.width, naturalSize.height, page.width, page.height);
  const { x, y } = centeredPosition(width, height, page.width, page.height);
  const element = {
    ...baseAttrs("Image", x, y),
    kind: "image",
    width,
    height,
    src,
    fit: "contain"
  };
  return addElementOp(page.pageId, element);
}
var DEFAULT_INSERT_TEMPLATES = [
  {
    id: "heading",
    label: "Heading",
    build(page) {
      const width = Math.min(480, Math.round(page.width * 0.7));
      const { x, y } = centeredPosition(width, 60, page.width, page.height);
      const element = {
        ...baseAttrs("Heading", x, y),
        kind: "text",
        text: "Add a headline",
        width,
        fontFamily: "Inter",
        fontSize: 48,
        fontStyle: "bold",
        fill: pageTextFill(page, "primary"),
        align: "left",
        lineHeight: 1.1,
        letterSpacing: 0
      };
      return [addElementOp(page.pageId, element)];
    }
  },
  {
    id: "body",
    label: "Body text",
    build(page) {
      const width = Math.min(420, Math.round(page.width * 0.6));
      const { x, y } = centeredPosition(width, 80, page.width, page.height);
      const element = {
        ...baseAttrs("Body", x, y),
        kind: "text",
        text: "Add a paragraph of supporting copy.",
        width,
        fontFamily: "Inter",
        fontSize: 20,
        fontStyle: "normal",
        fill: pageTextFill(page, "secondary"),
        align: "left",
        lineHeight: 1.4,
        letterSpacing: 0
      };
      return [addElementOp(page.pageId, element)];
    }
  },
  {
    id: "rect",
    label: "Rectangle",
    build(page) {
      const width = Math.min(320, Math.round(page.width * 0.4));
      const height = Math.min(200, Math.round(page.height * 0.3));
      const { x, y } = centeredPosition(width, height, page.width, page.height);
      const element = {
        ...baseAttrs("Rectangle", x, y),
        kind: "rect",
        width,
        height,
        fill: "#6366f1",
        cornerRadius: 12
      };
      return [addElementOp(page.pageId, element)];
    }
  },
  {
    id: "ellipse",
    label: "Ellipse",
    build(page) {
      const size = Math.min(220, Math.round(Math.min(page.width, page.height) * 0.3));
      const { x, y } = centeredPosition(size, size, page.width, page.height);
      const element = {
        ...baseAttrs("Ellipse", x, y),
        kind: "ellipse",
        width: size,
        height: size,
        fill: "#10b981"
      };
      return [addElementOp(page.pageId, element)];
    }
  }
];

export {
  createSnapEngine,
  collectGridTargets,
  hitTestPoint,
  marqueeSelect,
  nudgeDelta,
  DUPLICATE_OFFSET,
  createZoomPanMath,
  isExportHiddenNodeName,
  resolveExportParams,
  NODE_CACHE_PIXEL_RATIO_MAX,
  resolveNodeCachePixelRatio,
  identifyTaintedSrc,
  isCrossOriginSrc,
  documentCropToStageCoords,
  MAX_INSERT_DIMENSION,
  mintElementId,
  fittedSize,
  centeredPosition,
  buildInsertImageOp,
  DEFAULT_INSERT_TEMPLATES
};
//# sourceMappingURL=chunk-2WVBGQ2Y.js.map