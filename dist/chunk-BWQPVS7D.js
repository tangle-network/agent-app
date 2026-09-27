import {
  assertMediaUrl
} from "./chunk-EA4UVS4T.js";

// src/design-canvas/model.ts
var SCENE_SCHEMA_VERSION = 1;
var SCENE_ELEMENT_KINDS = [
  "rect",
  "ellipse",
  "line",
  "text",
  "image",
  "video",
  "group"
];
function elementExtent(element) {
  switch (element.kind) {
    case "rect":
    case "ellipse":
    case "image":
    case "video":
      return { width: element.width, height: element.height };
    case "text":
      return {
        width: element.width,
        height: estimateTextHeight(element)
      };
    case "line": {
      let maxX = 0;
      let maxY = 0;
      for (let i = 0; i < element.points.length; i += 2) {
        maxX = Math.max(maxX, Math.abs(element.points[i]));
        maxY = Math.max(maxY, Math.abs(element.points[i + 1]));
      }
      return { width: maxX, height: maxY };
    }
    case "group": {
      let minX = 0, minY = 0, maxX = 0, maxY = 0;
      for (const child of element.children) {
        const aabb = elementAabb(child);
        minX = Math.min(minX, aabb.x);
        minY = Math.min(minY, aabb.y);
        maxX = Math.max(maxX, aabb.x + aabb.width);
        maxY = Math.max(maxY, aabb.y + aabb.height);
      }
      return { width: maxX - minX, height: maxY - minY };
    }
  }
}
function estimateTextHeight(element) {
  const lines = element.text.length === 0 ? 1 : element.text.split("\n").length;
  return lines * element.fontSize * element.lineHeight;
}
function elementAabb(element) {
  const { width, height } = elementExtent(element);
  if (element.rotation % 360 === 0) {
    return { x: element.x, y: element.y, width, height };
  }
  const rad = element.rotation * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = [
    [0, 0],
    [width * cos, width * sin],
    [-height * sin, height * cos],
    [width * cos - height * sin, width * sin + height * cos]
  ];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [cx, cy] of corners) {
    minX = Math.min(minX, cx);
    minY = Math.min(minY, cy);
    maxX = Math.max(maxX, cx);
    maxY = Math.max(maxY, cy);
  }
  return { x: element.x + minX, y: element.y + minY, width: maxX - minX, height: maxY - minY };
}
function boundsIntersect(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
function requirePage(document, pageId) {
  const page = document.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error(`page ${pageId} not found in document`);
  return page;
}
function findElement(page, elementId) {
  const stack = [page.elements];
  while (stack.length > 0) {
    const owner = stack.pop();
    for (let index = 0; index < owner.length; index += 1) {
      const element = owner[index];
      if (element.id === elementId) return { element, owner, index };
      if (element.kind === "group") stack.push(element.children);
    }
  }
  return null;
}
function requireElement(page, elementId) {
  const found = findElement(page, elementId);
  if (!found) throw new Error(`element ${elementId} not found on page ${page.id}`);
  return found;
}
function collectSlots(document) {
  const slots = /* @__PURE__ */ new Map();
  for (const page of document.pages) {
    const stack = [...page.elements];
    while (stack.length > 0) {
      const element = stack.pop();
      if (element.slot) {
        if (slots.has(element.slot)) throw new Error(`duplicate slot name "${element.slot}"`);
        slots.set(element.slot, { pageId: page.id, elementId: element.id, kind: element.kind });
      }
      if (element.kind === "group") stack.push(...element.children);
    }
  }
  return slots;
}
function createEmptyDocument(title, page) {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    title,
    pages: [createPage(page ?? {}, "page-1")],
    settings: { dpi: 96 },
    metadata: {}
  };
}
function createPage(options, id) {
  const width = options.width ?? 1080;
  const height = options.height ?? 1080;
  assertPositiveFinite(width, "page width");
  assertPositiveFinite(height, "page height");
  return {
    id,
    name: options.name ?? "Page",
    width,
    height,
    background: options.background ?? "#ffffff",
    bleed: null,
    guides: { vertical: [], horizontal: [] },
    elements: []
  };
}
function assertPositiveFinite(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number`);
}
function assertFinite(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
}
var HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
var RGB_COLOR = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/;
function assertColor(value, label) {
  if (value === "transparent" || HEX_COLOR.test(value)) return;
  const rgb = RGB_COLOR.exec(value);
  if (rgb && rgbChannelsInRange(rgb)) return;
  throw new Error(`${label} must be a hex/rgb(a) color or 'transparent', got "${value}"`);
}
function rgbChannelsInRange(match) {
  for (let i = 1; i <= 3; i += 1) {
    const channel = Number(match[i]);
    if (channel > 255) return false;
  }
  return true;
}
function assertSceneMediaSrc(value, label) {
  assertMediaUrl(value, label);
}

// src/design-canvas/validate.ts
function validateSceneOperations(document, operations) {
  operations.forEach((operation, index) => {
    try {
      validateSceneOperation(document, operation);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`operation ${index + 1} (${operation.type}): ${reason}`);
    }
  });
}
function validateSceneOperation(document, operation) {
  switch (operation.type) {
    case "add_element":
      return validateAddElement(document, operation);
    case "set_attrs":
      return validateSetAttrs(document, operation);
    case "reorder_element":
      return validateReorderElement(document, operation);
    case "delete_element":
      return validateDeleteElement(document, operation);
    case "group_elements":
      return validateGroupElements(document, operation);
    case "ungroup_element":
      return validateUngroupElement(document, operation);
    case "add_page":
      return validateAddPage(operation);
    case "duplicate_page":
      return validateDuplicatePage(document, operation);
    case "delete_page":
      return validateDeletePage(document, operation);
    case "reorder_page":
      return validateReorderPage(document, operation);
    case "set_page_props":
      return validateSetPageProps(document, operation);
    case "set_page_guides":
      return validateSetPageGuides(document, operation);
    case "bind_slot":
      return validateBindSlot(document, operation);
    case "apply_data":
      return validateApplyData(document, operation);
    case "set_document_title":
      return validateSetDocumentTitle(operation);
    default: {
      const unknown = operation;
      throw new Error(`unsupported operation type ${JSON.stringify(unknown.type)}`);
    }
  }
}
function validateAddElement(document, op) {
  const page = requirePage(document, op.pageId);
  assertUniqueIdDocumentWide(document, op.element.id);
  if (op.parentGroupId !== void 0) {
    const { element: parent } = requireElement(page, op.parentGroupId);
    if (parent.kind !== "group") {
      throw new Error(`parentGroupId "${op.parentGroupId}" is a ${parent.kind}, not a group`);
    }
  }
  if (op.index !== void 0) {
    const owner = op.parentGroupId ? (() => {
      const { element: g } = requireElement(page, op.parentGroupId);
      return g.children;
    })() : page.elements;
    if (op.index < 0 || op.index > owner.length) {
      throw new Error(`index ${op.index} out of range (owner has ${owner.length} elements)`);
    }
  }
  validateElementAttrs(op.element.kind, op.element, true);
}
function validateSetAttrs(document, op) {
  const page = requirePage(document, op.pageId);
  const { element } = requireElement(page, op.elementId);
  const isUnlockOnly = Object.keys(op.attrs).length === 1 && op.attrs.locked === false;
  if (element.locked && !isUnlockOnly) {
    throw new Error(`element "${op.elementId}" is locked; unlock it first (pass attrs: {locked: false}) before making other changes`);
  }
  validateElementAttrs(element.kind, op.attrs, false);
}
function validateReorderElement(document, op) {
  const page = requirePage(document, op.pageId);
  const { element, owner } = requireElement(page, op.elementId);
  if (element.locked) {
    throw new Error(`element "${op.elementId}" is locked; unlock it before reordering`);
  }
  if (op.toIndex < 0 || op.toIndex >= owner.length) {
    throw new Error(`toIndex ${op.toIndex} out of range (owner has ${owner.length} elements)`);
  }
}
function validateDeleteElement(document, op) {
  const page = requirePage(document, op.pageId);
  const { element } = requireElement(page, op.elementId);
  if (element.locked) {
    throw new Error(`element "${op.elementId}" is locked; unlock it before deleting`);
  }
}
function validateGroupElements(document, op) {
  if (op.elementIds.length < 2) {
    throw new Error(`group_elements requires \u2265 2 element ids (got ${op.elementIds.length})`);
  }
  assertUniqueIdDocumentWide(document, op.groupId);
  const page = requirePage(document, op.pageId);
  const owners = op.elementIds.map((id) => {
    const { element, owner } = requireElement(page, id);
    if (element.locked) throw new Error(`element "${id}" is locked; unlock before grouping`);
    return owner;
  });
  const firstOwner = owners[0];
  for (let i = 1; i < owners.length; i++) {
    if (owners[i] !== firstOwner) {
      throw new Error(`elements are not siblings \u2014 they must all share the same parent (page root or one group)`);
    }
  }
}
function validateUngroupElement(document, op) {
  const page = requirePage(document, op.pageId);
  const { element } = requireElement(page, op.groupId);
  if (element.kind !== "group") {
    throw new Error(`element "${op.groupId}" is a ${element.kind}, not a group`);
  }
}
function validateAddPage(op) {
  const opts = op.options;
  if (!opts) return;
  if (opts.width !== void 0) assertPositiveFinite(opts.width, "page width");
  if (opts.height !== void 0) assertPositiveFinite(opts.height, "page height");
  if (opts.background !== void 0) assertColor(opts.background, "page background");
}
function validateDuplicatePage(document, op) {
  requirePage(document, op.sourcePageId);
  const existing = document.pages.find((p) => p.id === op.pageId);
  if (existing) throw new Error(`pageId "${op.pageId}" already exists in the document`);
}
function validateDeletePage(document, op) {
  requirePage(document, op.pageId);
  if (document.pages.length === 1) {
    throw new Error("cannot delete the last remaining page");
  }
}
function validateReorderPage(document, op) {
  requirePage(document, op.pageId);
  if (op.toIndex < 0 || op.toIndex >= document.pages.length) {
    throw new Error(`toIndex ${op.toIndex} out of range (document has ${document.pages.length} pages)`);
  }
}
function validateSetPageProps(document, op) {
  requirePage(document, op.pageId);
  if (op.width !== void 0) assertPositiveFinite(op.width, "page width");
  if (op.height !== void 0) assertPositiveFinite(op.height, "page height");
  if (op.background !== void 0) assertColor(op.background, "page background");
  if (op.bleed != null) {
    assertNonNegativeFinite(op.bleed.top, "bleed.top");
    assertNonNegativeFinite(op.bleed.right, "bleed.right");
    assertNonNegativeFinite(op.bleed.bottom, "bleed.bottom");
    assertNonNegativeFinite(op.bleed.left, "bleed.left");
  }
}
function validateSetPageGuides(document, op) {
  requirePage(document, op.pageId);
  for (const pos of op.guides.vertical) {
    if (!Number.isFinite(pos)) throw new Error(`guide position ${pos} is not finite`);
  }
  for (const pos of op.guides.horizontal) {
    if (!Number.isFinite(pos)) throw new Error(`guide position ${pos} is not finite`);
  }
}
function validateBindSlot(document, op) {
  const page = requirePage(document, op.pageId);
  requireElement(page, op.elementId);
  if (op.slot === null) return;
  for (const p of document.pages) {
    const stack = [...p.elements];
    while (stack.length > 0) {
      const el = stack.pop();
      if (el.slot === op.slot && el.id !== op.elementId) {
        throw new Error(`slot "${op.slot}" is already bound to element "${el.id}" on page "${p.id}"`);
      }
      if (el.kind === "group") stack.push(...el.children);
    }
  }
}
function validateApplyData(document, op) {
  const slots = collectSlots(document);
  for (const [slotName, value] of Object.entries(op.bindings)) {
    const slot = slots.get(slotName);
    if (!slot) {
      throw new Error(`slot "${slotName}" does not exist in the document`);
    }
    validateSlotValue(slotName, slot.kind, value);
  }
}
function validateSetDocumentTitle(op) {
  if (op.title.trim().length === 0) throw new Error("title must be non-empty");
}
var BASE_ATTRS = /* @__PURE__ */ new Set([
  "name",
  "x",
  "y",
  "rotation",
  "opacity",
  "locked",
  "visible",
  "slot"
]);
var KIND_ATTRS = {
  rect: /* @__PURE__ */ new Set(["width", "height", "fill", "stroke", "strokeWidth", "cornerRadius"]),
  ellipse: /* @__PURE__ */ new Set(["width", "height", "fill", "stroke", "strokeWidth"]),
  line: /* @__PURE__ */ new Set(["points", "stroke", "strokeWidth", "dash"]),
  text: /* @__PURE__ */ new Set(["text", "width", "fontFamily", "fontSize", "fontStyle", "fill", "align", "lineHeight", "letterSpacing"]),
  image: /* @__PURE__ */ new Set(["width", "height", "src", "fit"]),
  video: /* @__PURE__ */ new Set(["width", "height", "src", "posterSrc"]),
  group: /* @__PURE__ */ new Set([])
};
var FONT_STYLES = /* @__PURE__ */ new Set(["normal", "bold", "italic", "bold italic"]);
var ALIGN_VALUES = /* @__PURE__ */ new Set(["left", "center", "right"]);
var FIT_VALUES = /* @__PURE__ */ new Set(["fill", "cover", "contain"]);
function validateElementAttrs(kind, attrs, isConstruction) {
  const allowed = KIND_ATTRS[kind];
  for (const key of Object.keys(attrs)) {
    if (key === "id" || key === "kind" || key === "children") continue;
    if (!BASE_ATTRS.has(key) && !allowed.has(key)) {
      throw new Error(`attribute "${key}" is not valid for a ${kind} element`);
    }
  }
  if (attrs.opacity !== void 0) {
    if (typeof attrs.opacity !== "number" || !Number.isFinite(attrs.opacity) || attrs.opacity < 0 || attrs.opacity > 1) {
      throw new Error("opacity must be a number in [0, 1]");
    }
  }
  if (attrs.x !== void 0) assertFinite(attrs.x, "x");
  if (attrs.y !== void 0) assertFinite(attrs.y, "y");
  if (attrs.rotation !== void 0) assertFinite(attrs.rotation, "rotation");
  switch (kind) {
    case "rect":
    case "ellipse":
    case "image":
    case "video":
      if (attrs.width !== void 0) assertPositiveFinite(attrs.width, "width");
      if (attrs.height !== void 0) assertPositiveFinite(attrs.height, "height");
      break;
    case "text":
      if (attrs.width !== void 0) assertPositiveFinite(attrs.width, "width");
      if (attrs.fontSize !== void 0) assertPositiveFinite(attrs.fontSize, "fontSize");
      if (attrs.lineHeight !== void 0) {
        if (typeof attrs.lineHeight !== "number" || !Number.isFinite(attrs.lineHeight) || attrs.lineHeight <= 0) {
          throw new Error("lineHeight must be a positive finite number");
        }
      }
      if (attrs.fontStyle !== void 0 && !FONT_STYLES.has(attrs.fontStyle)) {
        throw new Error(`fontStyle must be one of: ${[...FONT_STYLES].join(", ")}`);
      }
      if (attrs.align !== void 0 && !ALIGN_VALUES.has(attrs.align)) {
        throw new Error(`align must be one of: ${[...ALIGN_VALUES].join(", ")}`);
      }
      break;
    case "line":
      if (attrs.points !== void 0) {
        if (!Array.isArray(attrs.points) || attrs.points.length < 4 || attrs.points.length % 2 !== 0) {
          throw new Error("points must be an even-length array with at least 4 numbers (2 points)");
        }
        for (let i = 0; i < attrs.points.length; i++) {
          if (!Number.isFinite(attrs.points[i])) {
            throw new Error(`points[${i}] is not finite`);
          }
        }
      }
      if (attrs.strokeWidth !== void 0) assertPositiveFinite(attrs.strokeWidth, "strokeWidth");
      break;
    case "group":
      break;
  }
  if (attrs.fill !== void 0) assertColor(attrs.fill, "fill");
  if (attrs.stroke !== void 0) assertColor(attrs.stroke, "stroke");
  if (attrs.strokeWidth !== void 0 && kind !== "line") {
    assertPositiveFinite(attrs.strokeWidth, "strokeWidth");
  }
  if (attrs.src !== void 0) assertSceneMediaSrc(attrs.src, "src");
  if (attrs.posterSrc !== void 0) {
    assertSceneMediaSrc(attrs.posterSrc, "posterSrc");
  }
  if (attrs.fit !== void 0 && !FIT_VALUES.has(attrs.fit)) {
    throw new Error(`fit must be one of: ${[...FIT_VALUES].join(", ")}`);
  }
  if (isConstruction) {
    validateRequiredConstructionAttrs(kind, attrs);
  }
}
function validateRequiredConstructionAttrs(kind, attrs) {
  switch (kind) {
    case "rect":
      requireAttrPresent(attrs, "width", kind);
      requireAttrPresent(attrs, "height", kind);
      requireAttrPresent(attrs, "fill", kind);
      break;
    case "ellipse":
      requireAttrPresent(attrs, "width", kind);
      requireAttrPresent(attrs, "height", kind);
      requireAttrPresent(attrs, "fill", kind);
      break;
    case "line":
      requireAttrPresent(attrs, "points", kind);
      requireAttrPresent(attrs, "stroke", kind);
      requireAttrPresent(attrs, "strokeWidth", kind);
      break;
    case "text":
      requireAttrPresent(attrs, "text", kind);
      requireAttrPresent(attrs, "width", kind);
      requireAttrPresent(attrs, "fontFamily", kind);
      requireAttrPresent(attrs, "fontSize", kind);
      requireAttrPresent(attrs, "fontStyle", kind);
      requireAttrPresent(attrs, "fill", kind);
      requireAttrPresent(attrs, "align", kind);
      requireAttrPresent(attrs, "lineHeight", kind);
      requireAttrPresent(attrs, "letterSpacing", kind);
      break;
    case "image":
      requireAttrPresent(attrs, "width", kind);
      requireAttrPresent(attrs, "height", kind);
      requireAttrPresent(attrs, "src", kind);
      requireAttrPresent(attrs, "fit", kind);
      break;
    case "video":
      requireAttrPresent(attrs, "width", kind);
      requireAttrPresent(attrs, "height", kind);
      requireAttrPresent(attrs, "src", kind);
      break;
    case "group":
      break;
  }
}
function requireAttrPresent(attrs, key, kind) {
  if (attrs[key] === void 0) {
    throw new Error(`${key} is required when constructing a ${kind} element`);
  }
}
function validateSlotValue(slotName, elementKind, value) {
  switch (elementKind) {
    case "text":
      return;
    case "image":
    case "video":
      try {
        assertSceneMediaSrc(value, `slot "${slotName}" value`);
      } catch (e) {
        throw new Error(
          `slot "${slotName}" is bound to a ${elementKind} element \u2014 value must be an http(s) URL or a rooted /api/ path (got "${value}")`
        );
      }
      return;
    case "rect":
    case "ellipse":
    case "line":
    case "group":
      try {
        assertColor(value, `slot "${slotName}" value`);
      } catch {
        throw new Error(
          `slot "${slotName}" is bound to a ${elementKind} element \u2014 value must be a color (hex/rgb(a)/transparent) for fill/stroke recolor (got "${value}")`
        );
      }
      return;
  }
}
function assertUniqueIdDocumentWide(document, id) {
  for (const page of document.pages) {
    if (page.id === id) throw new Error(`id "${id}" is already used by a page`);
    const stack = [...page.elements];
    while (stack.length > 0) {
      const el = stack.pop();
      if (el.id === id) throw new Error(`id "${id}" is already used by element on page "${page.id}"`);
      if (el.kind === "group") stack.push(...el.children);
    }
  }
}
function assertNonNegativeFinite(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
}

// src/design-canvas/apply.ts
function applySceneOperations(document, operations, options) {
  const opts = options ?? { mintId: makeCounter() };
  const doc = deepCloneDocument(document);
  const results = [];
  for (const operation of operations) {
    results.push(applyOneOperation(doc, operation, opts));
  }
  return options !== void 0 ? { document: doc, results } : doc;
}
function applySceneOperation(document, operation) {
  return applySceneOperations(document, [operation]);
}
function makeCounter() {
  let n = 0;
  return () => `minted-${n += 1}`;
}
function isStaleRevError(err) {
  return err instanceof Error && /stale rev/i.test(err.message);
}
async function storeApplyScenePlan(store, plan, opts) {
  let { document, rev } = await store.getDocument();
  validateSceneOperations(document, plan.operations);
  let applied = applySceneOperations(document, plan.operations, { mintId: opts.mintId });
  let record;
  try {
    record = await store.saveDocument(applied.document, rev);
  } catch (firstError) {
    if (!isStaleRevError(firstError)) throw firstError;
    const refreshed = await store.getDocument();
    validateSceneOperations(refreshed.document, plan.operations);
    applied = applySceneOperations(refreshed.document, plan.operations, { mintId: opts.mintId });
    try {
      record = await store.saveDocument(applied.document, refreshed.rev);
    } catch (secondError) {
      const reason = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(`storeApplyScenePlan: stale rev persists after retry \u2014 ${reason}`);
    }
  }
  const opTypeCounts = {};
  for (const op of plan.operations) {
    opTypeCounts[op.type] = (opTypeCounts[op.type] ?? 0) + 1;
  }
  await store.recordDecision({
    kind: opts.actorKind,
    instruction: plan.summary,
    metadata: { opTypeCounts, operationCount: plan.operations.length }
  });
  return { record, results: applied.results };
}
function applyOneOperation(doc, operation, options) {
  switch (operation.type) {
    case "add_element":
      return applyAddElement(doc, operation);
    case "set_attrs":
      return applySetAttrs(doc, operation);
    case "reorder_element":
      return applyReorderElement(doc, operation);
    case "delete_element":
      return applyDeleteElement(doc, operation);
    case "group_elements":
      return applyGroupElements(doc, operation);
    case "ungroup_element":
      return applyUngroupElement(doc, operation);
    case "add_page":
      return applyAddPage(doc, operation);
    case "duplicate_page":
      return applyDuplicatePage(doc, operation, options);
    case "delete_page":
      return applyDeletePage(doc, operation);
    case "reorder_page":
      return applyReorderPage(doc, operation);
    case "set_page_props":
      return applySetPageProps(doc, operation);
    case "set_page_guides":
      return applySetPageGuides(doc, operation);
    case "bind_slot":
      return applyBindSlot(doc, operation);
    case "apply_data":
      return applyApplyData(doc, operation);
    case "set_document_title":
      return applySetDocumentTitle(doc, operation);
  }
}
function applyAddElement(doc, op) {
  const page = requirePage(doc, op.pageId);
  const owner = op.parentGroupId !== void 0 ? (() => {
    const { element: g } = requireElement(page, op.parentGroupId);
    return g.children;
  })() : page.elements;
  const index = op.index !== void 0 ? op.index : owner.length;
  owner.splice(index, 0, op.element);
  return { kind: "element", pageId: op.pageId, element: op.element };
}
function applySetAttrs(doc, op) {
  const page = requirePage(doc, op.pageId);
  const { element, owner, index } = requireElement(page, op.elementId);
  const patched = { ...element, ...op.attrs };
  owner[index] = patched;
  return { kind: "element", pageId: op.pageId, element: patched };
}
function applyReorderElement(doc, op) {
  const page = requirePage(doc, op.pageId);
  const { element, owner, index } = requireElement(page, op.elementId);
  owner.splice(index, 1);
  owner.splice(op.toIndex, 0, element);
  return { kind: "element", pageId: op.pageId, element };
}
function applyDeleteElement(doc, op) {
  const page = requirePage(doc, op.pageId);
  const { element, owner, index } = requireElement(page, op.elementId);
  owner.splice(index, 1);
  return { kind: "element", pageId: op.pageId, element };
}
function applyGroupElements(doc, op) {
  const page = requirePage(doc, op.pageId);
  const members = op.elementIds.map((id) => requireElement(page, id));
  let minX = Infinity, minY = Infinity;
  for (const { element } of members) {
    const aabb = elementAabb(element);
    if (aabb.x < minX) minX = aabb.x;
    if (aabb.y < minY) minY = aabb.y;
  }
  const owner = members[0].owner;
  const sortedByIndex = [...members].sort((a, b) => a.index - b.index);
  const children = sortedByIndex.map(({ element }) => ({
    ...element,
    x: element.x - minX,
    y: element.y - minY
  }));
  for (const { index } of [...sortedByIndex].reverse()) {
    owner.splice(index, 1);
  }
  const insertAt = sortedByIndex[0].index;
  const group = {
    id: op.groupId,
    kind: "group",
    name: op.name ?? "Group",
    x: minX,
    y: minY,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    children
  };
  owner.splice(insertAt, 0, group);
  return { kind: "element", pageId: op.pageId, element: group };
}
function applyUngroupElement(doc, op) {
  const page = requirePage(doc, op.pageId);
  const { element: groupEl, owner, index: groupIndex } = requireElement(page, op.groupId);
  const group = groupEl;
  const promoted = group.children.map((child) => ({
    ...child,
    x: child.x + group.x,
    y: child.y + group.y
  }));
  owner.splice(groupIndex, 1, ...promoted);
  return { kind: "element", pageId: op.pageId, element: groupEl };
}
function applyAddPage(doc, op) {
  const opts = op.options ?? {};
  const page = createPage(opts, op.pageId);
  const index = op.index !== void 0 ? op.index : doc.pages.length;
  doc.pages.splice(index, 0, page);
  return { kind: "page", page };
}
function applyDuplicatePage(doc, op, options) {
  const source = requirePage(doc, op.sourcePageId);
  const copy = JSON.parse(JSON.stringify(source));
  copy.id = op.pageId;
  remintElementIds(copy.elements, options.mintId);
  doc.pages.push(copy);
  return { kind: "page", page: copy };
}
function remintElementIds(elements, mintId) {
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const newEl = { ...el, id: mintId() };
    if (newEl.kind === "group") {
      remintElementIds(newEl.children, mintId);
    }
    elements[i] = newEl;
  }
}
function applyDeletePage(doc, op) {
  if (doc.pages.length <= 1) throw new Error("delete_page: cannot delete the last page");
  const index = doc.pages.findIndex((p) => p.id === op.pageId);
  if (index < 0) throw new Error(`page ${op.pageId} not found`);
  const [page] = doc.pages.splice(index, 1);
  return { kind: "page", page };
}
function applyReorderPage(doc, op) {
  const index = doc.pages.findIndex((p) => p.id === op.pageId);
  if (index < 0) throw new Error(`page ${op.pageId} not found`);
  const [page] = doc.pages.splice(index, 1);
  doc.pages.splice(op.toIndex, 0, page);
  return { kind: "page", page };
}
function applySetPageProps(doc, op) {
  const page = requirePage(doc, op.pageId);
  if (op.name !== void 0) page.name = op.name;
  if (op.width !== void 0) page.width = op.width;
  if (op.height !== void 0) page.height = op.height;
  if (op.background !== void 0) page.background = op.background;
  if (op.bleed !== void 0) page.bleed = op.bleed;
  return { kind: "page", page };
}
function applySetPageGuides(doc, op) {
  const page = requirePage(doc, op.pageId);
  page.guides = op.guides;
  return { kind: "page", page };
}
function applyBindSlot(doc, op) {
  const page = requirePage(doc, op.pageId);
  const { element, owner, index } = requireElement(page, op.elementId);
  const patched = op.slot === null ? omitSlot(element) : { ...element, slot: op.slot };
  owner[index] = patched;
  return { kind: "element", pageId: op.pageId, element: patched };
}
function omitSlot(element) {
  const { slot: _slot, ...rest } = element;
  return rest;
}
function applyApplyData(doc, op) {
  const slots = collectSlots(doc);
  for (const [slotName, value] of Object.entries(op.bindings)) {
    const slot = slots.get(slotName);
    if (!slot) throw new Error(`slot "${slotName}" not found in document`);
    const page = requirePage(doc, slot.pageId);
    const { element, owner, index } = requireElement(page, slot.elementId);
    owner[index] = applySlotValue(element, value);
  }
  return { kind: "document" };
}
function applySlotValue(element, value) {
  switch (element.kind) {
    case "text":
      return { ...element, text: value };
    case "image":
    case "video":
      assertSceneMediaSrc(value, "slot value");
      return { ...element, src: value };
    case "rect":
    case "ellipse":
      assertColor(value, "slot value");
      return { ...element, fill: value };
    case "line":
      assertColor(value, "slot value");
      return { ...element, stroke: value };
    case "group":
      assertColor(value, "slot value");
      return recolorGroupChildren(element, value);
  }
}
function recolorGroupChildren(group, color) {
  const children = group.children.map((child) => {
    switch (child.kind) {
      case "rect":
      case "ellipse":
        return { ...child, fill: color };
      case "line":
        return { ...child, stroke: color };
      case "text":
        return { ...child, fill: color };
      case "image":
      case "video":
        return child;
      case "group":
        return recolorGroupChildren(child, color);
    }
  });
  return { ...group, children };
}
function applySetDocumentTitle(doc, op) {
  doc.title = op.title;
  return { kind: "document" };
}
function deepCloneDocument(document) {
  return JSON.parse(JSON.stringify(document));
}

// src/design-canvas/export-presets.ts
var SIZE_PRESETS = [
  // Social
  { id: "instagram-square", label: "Instagram \u2014 Square", category: "social", width: 1080, height: 1080 },
  { id: "instagram-portrait", label: "Instagram \u2014 Portrait", category: "social", width: 1080, height: 1350 },
  { id: "instagram-story", label: "Instagram Story", category: "social", width: 1080, height: 1920 },
  { id: "twitter-post", label: "X / Twitter Post", category: "social", width: 1200, height: 675 },
  { id: "linkedin-post", label: "LinkedIn Post", category: "social", width: 1200, height: 627 },
  { id: "facebook-post", label: "Facebook Post", category: "social", width: 1200, height: 630 },
  { id: "youtube-thumbnail", label: "YouTube Thumbnail", category: "social", width: 1280, height: 720 },
  { id: "og-image", label: "Open Graph Image", category: "social", width: 1200, height: 630 },
  // Presentation
  { id: "slide-16-9", label: "Slide \u2014 16:9", category: "presentation", width: 1920, height: 1080 },
  { id: "slide-4-3", label: "Slide \u2014 4:3", category: "presentation", width: 1024, height: 768 },
  // Print (96 DPI px equivalents of A4, Letter — products may scale at export)
  { id: "a4-landscape", label: "A4 Landscape", category: "print", width: 1123, height: 794 },
  { id: "a4-portrait", label: "A4 Portrait", category: "print", width: 794, height: 1123 },
  { id: "us-letter-landscape", label: "US Letter Landscape", category: "print", width: 1100, height: 850 },
  { id: "us-letter-portrait", label: "US Letter Portrait", category: "print", width: 850, height: 1100 }
];
function findPreset(id) {
  return SIZE_PRESETS.find((p) => p.id === id) ?? null;
}
function matchPreset(width, height) {
  return SIZE_PRESETS.find((p) => p.width === width && p.height === height) ?? null;
}
var EXPORT_PRESETS = {
  "instagram-square": {
    name: "Instagram square (1080\xD71080)",
    pixelRatio: 1,
    outputWidth: 1080,
    outputHeight: 1080,
    includeBleed: false,
    format: "jpeg"
  },
  "instagram-portrait": {
    name: "Instagram portrait (1080\xD71350)",
    pixelRatio: 1,
    outputWidth: 1080,
    outputHeight: 1350,
    includeBleed: false,
    format: "jpeg"
  },
  "twitter-card": {
    name: "Twitter/X card (1200\xD7675)",
    pixelRatio: 1,
    outputWidth: 1200,
    outputHeight: 675,
    includeBleed: false,
    format: "jpeg"
  },
  "og-image": {
    name: "OG image (1200\xD7630)",
    pixelRatio: 1,
    outputWidth: 1200,
    outputHeight: 630,
    includeBleed: false,
    format: "png"
  },
  "print-a4": {
    name: "Print A4 (300 dpi)",
    pixelRatio: 3.125,
    outputWidth: null,
    outputHeight: null,
    includeBleed: true,
    format: "png"
  },
  "screen-2x": {
    name: "Screen @2\xD7",
    pixelRatio: 2,
    outputWidth: null,
    outputHeight: null,
    includeBleed: false,
    format: "png"
  }
};
function bleedAwareExportBounds(page, includeBleed) {
  if (!includeBleed || page.bleed === null) {
    return { x: 0, y: 0, width: page.width, height: page.height };
  }
  const bleed = page.bleed;
  return {
    x: -bleed.left,
    y: -bleed.top,
    width: page.width + bleed.left + bleed.right,
    height: page.height + bleed.top + bleed.bottom
  };
}
function scaleForPreset(preset, cropRect) {
  if (preset.outputWidth !== null) {
    if (cropRect.width <= 0) {
      throw new Error(`export crop width must be positive, got ${cropRect.width}`);
    }
    return preset.outputWidth / cropRect.width;
  }
  return preset.pixelRatio;
}
var CHANNEL_PRESETS = [
  { id: "square_1080", label: "Square (1080\xD71080)", width: 1080, height: 1080 },
  { id: "portrait_1080x1350", label: "Portrait (1080\xD71350)", width: 1080, height: 1350 },
  { id: "story_1080x1920", label: "Story (1080\xD71920)", width: 1080, height: 1920 },
  { id: "landscape_1200x628", label: "Landscape (1200\xD7628)", width: 1200, height: 628 },
  { id: "wide_1920x1080", label: "Wide (1920\xD71080)", width: 1920, height: 1080 },
  { id: "og_1200x630", label: "Open Graph (1200\xD7630)", width: 1200, height: 630 },
  { id: "a4_print_2480x3508", label: "A4 Print (2480\xD73508 \xB7 300 dpi)", width: 2480, height: 3508 }
];
function requireChannelPreset(id) {
  const found = CHANNEL_PRESETS.find((p) => p.id === id);
  if (!found) {
    throw new Error(
      `unknown channel preset "${id}" \u2014 valid ids: ${CHANNEL_PRESETS.map((p) => p.id).join(", ")}`
    );
  }
  return found;
}
function scalePageForChannelPreset(page, channelPreset) {
  if (page.width <= 0 || page.height <= 0) {
    throw new Error(`page dimensions must be positive; got ${page.width}\xD7${page.height}`);
  }
  const scaleX = channelPreset.width / page.width;
  const scaleY = channelPreset.height / page.height;
  const pixelRatio = Math.min(scaleX, scaleY);
  const renderedW = page.width * pixelRatio;
  const renderedH = page.height * pixelRatio;
  const offsetX = (channelPreset.width - renderedW) / 2 / pixelRatio;
  const offsetY = (channelPreset.height - renderedH) / 2 / pixelRatio;
  return { pixelRatio, offsetX, offsetY, fit: "contain" };
}
function bleedAwareExportRect(page) {
  if (page.bleed === null) {
    return { x: 0, y: 0, width: page.width, height: page.height };
  }
  const bleed = page.bleed;
  return {
    x: -bleed.left,
    y: -bleed.top,
    width: page.width + bleed.left + bleed.right,
    height: page.height + bleed.top + bleed.bottom
  };
}

export {
  SCENE_SCHEMA_VERSION,
  SCENE_ELEMENT_KINDS,
  elementExtent,
  estimateTextHeight,
  elementAabb,
  boundsIntersect,
  requirePage,
  findElement,
  requireElement,
  collectSlots,
  createEmptyDocument,
  createPage,
  assertPositiveFinite,
  assertFinite,
  assertColor,
  assertSceneMediaSrc,
  validateSceneOperations,
  validateSceneOperation,
  validateSlotValue,
  applySceneOperations,
  applySceneOperation,
  storeApplyScenePlan,
  SIZE_PRESETS,
  findPreset,
  matchPreset,
  EXPORT_PRESETS,
  bleedAwareExportBounds,
  scaleForPreset,
  CHANNEL_PRESETS,
  requireChannelPreset,
  scalePageForChannelPreset,
  bleedAwareExportRect
};
//# sourceMappingURL=chunk-BWQPVS7D.js.map