import {
  CHANNEL_PRESETS,
  EXPORT_PRESETS,
  SCENE_ELEMENT_KINDS,
  SCENE_SCHEMA_VERSION,
  SIZE_PRESETS,
  applySceneOperation,
  applySceneOperations,
  assertColor,
  assertFinite,
  assertPositiveFinite,
  assertSceneMediaSrc,
  bleedAwareExportBounds,
  bleedAwareExportRect,
  boundsIntersect,
  collectSlots,
  createEmptyDocument,
  createPage,
  elementAabb,
  elementExtent,
  estimateTextHeight,
  findElement,
  findPreset,
  matchPreset,
  requireChannelPreset,
  requireElement,
  requirePage,
  scaleForPreset,
  scalePageForChannelPreset,
  storeApplyScenePlan,
  validateSceneOperation,
  validateSceneOperations,
  validateSlotValue
} from "../chunk-BWQPVS7D.js";
import {
  buildScopedMcpServerEntry,
  createMcpToolHandler
} from "../chunk-6A7MYOUI.js";
import "../chunk-EA4UVS4T.js";
import "../chunk-TXD5HXLE.js";

// src/design-canvas/operations.ts
var SCENE_OPERATION_TYPES = [
  "add_element",
  "set_attrs",
  "reorder_element",
  "delete_element",
  "group_elements",
  "ungroup_element",
  "add_page",
  "duplicate_page",
  "delete_page",
  "reorder_page",
  "set_page_props",
  "set_page_guides",
  "bind_slot",
  "apply_data",
  "set_document_title"
];

// src/design-canvas/templates.ts
function listTemplateSlots(document) {
  const raw = collectSlots(document);
  const slots = [];
  for (const [name, { pageId, elementId, kind }] of raw) {
    slots.push({ name, pageId, elementId, elementKind: kind, fillKind: fillKindForElementKind(kind) });
  }
  return slots;
}
function fillKindForElementKind(kind) {
  switch (kind) {
    case "text":
      return "text";
    case "image":
    case "video":
      return "src";
    case "rect":
    case "ellipse":
      return "color";
    case "line":
    case "group":
      throw new Error(
        `slot on "${kind}" element has no defined fill kind \u2014 bind_slot should not target line or group elements`
      );
  }
}
function validateBindings(document, bindings) {
  const slots = collectSlots(document);
  const problems = [];
  for (const key of Object.keys(bindings)) {
    if (!slots.has(key)) {
      problems.push(`binding key "${key}" does not match any slot in the document`);
    }
  }
  return problems;
}
function instantiateTemplate(document, options) {
  const bindings = options.bindings ?? {};
  const problems = validateBindings(document, bindings);
  if (problems.length > 0) {
    throw new Error(`template bindings are invalid:
${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  const idMap = /* @__PURE__ */ new Map();
  const allocate = (sourceId) => {
    if (idMap.has(sourceId)) return idMap.get(sourceId);
    const minted = options.mintId(sourceId);
    idMap.set(sourceId, minted);
    return minted;
  };
  for (const page of document.pages) {
    allocate(page.id);
    collectElementIds(page.elements, allocate);
  }
  const newPages = document.pages.map((page) => ({
    ...page,
    id: idMap.get(page.id),
    elements: copyElements(page.elements, idMap)
  }));
  const newDocument = {
    schemaVersion: SCENE_SCHEMA_VERSION,
    title: options.title,
    pages: newPages,
    settings: { ...document.settings },
    metadata: {
      ...document.metadata,
      templateSourceId: document.title
    }
  };
  return Object.keys(bindings).length > 0 ? applyBindings(newDocument, bindings) : newDocument;
}
function applyBindingsToDocument(document, bindings) {
  const problems = validateBindings(document, bindings);
  if (problems.length > 0) {
    throw new Error(`apply_data bindings are invalid:
${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return applyBindings(document, bindings);
}
function applyBindings(document, bindings) {
  const slots = collectSlots(document);
  const targetMap = /* @__PURE__ */ new Map();
  for (const [slotName, { elementId }] of slots) {
    const value = bindings[slotName];
    if (value !== void 0) {
      targetMap.set(elementId, { slotName, value });
    }
  }
  const newPages = document.pages.map((page) => ({
    ...page,
    elements: applyBindingsToElements(page.elements, targetMap)
  }));
  return { ...document, pages: newPages };
}
function applyBindingsToElements(elements, targetMap) {
  return elements.map((element) => {
    const target = targetMap.get(element.id);
    let updated = element;
    if (target !== void 0) {
      updated = applyBindingToElement(element, target.value, target.slotName);
    }
    if (updated.kind === "group") {
      return { ...updated, children: applyBindingsToElements(updated.children, targetMap) };
    }
    return updated;
  });
}
function applyBindingToElement(element, value, slotName) {
  switch (element.kind) {
    case "text":
      return { ...element, text: value };
    case "image":
      return { ...element, src: value };
    case "video":
      return { ...element, src: value };
    case "rect":
      return { ...element, fill: value };
    case "ellipse":
      return { ...element, fill: value };
    case "line":
    case "group":
      throw new Error(
        `slot "${slotName}" on "${element.kind}" element cannot accept a binding \u2014 remove the slot or use a supported element kind`
      );
  }
}
function collectElementIds(elements, allocate) {
  for (const element of elements) {
    allocate(element.id);
    if (element.kind === "group") collectElementIds(element.children, allocate);
  }
}
function copyElements(elements, idMap) {
  return elements.map((element) => copyElement(element, idMap));
}
function copyElement(element, idMap) {
  const newId = idMap.get(element.id);
  if (newId === void 0) throw new Error(`element ${element.id} was not pre-allocated in the id map \u2014 this is a bug in instantiateTemplate`);
  const base = { ...element, id: newId };
  if (base.kind === "group") {
    return { ...base, children: copyElements(base.children, idMap) };
  }
  return base;
}

// src/design-canvas/mcp-tools.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireString(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required and must be a non-empty string`);
  }
  return value;
}
function optionalString(args, name) {
  const value = args[name];
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string") throw new Error(`${name} must be a string when provided`);
  return value;
}
function requireNumber(args, name) {
  const value = args[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} is required and must be a finite number`);
  }
  return value;
}
function optionalNumber(args, name) {
  const value = args[name];
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number when provided`);
  }
  return value;
}
function optionalNonNegativeInteger(args, name) {
  const value = args[name];
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer when provided`);
  }
  return value;
}
function requireStringArray(args, name) {
  const value = args[name];
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string")) {
    throw new Error(`${name} is required and must be a non-empty array of strings`);
  }
  return value;
}
function optionalRecord(args, name) {
  const value = args[name];
  if (value === void 0 || value === null) return void 0;
  if (!isRecord(value) || Object.values(value).some((v) => typeof v !== "string")) {
    throw new Error(`${name} must be an object mapping string keys to string values when provided`);
  }
  return value;
}
function requireEnum(args, name, values) {
  const value = args[name];
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${name} must be one of: ${values.join(", ")}`);
  }
  return value;
}
function optionalEnum(args, name, values) {
  const value = args[name];
  if (value === void 0 || value === null) return void 0;
  return requireEnum(args, name, values);
}
function resolvePageId(document, args) {
  const pageId = optionalString(args, "page_id");
  if (pageId) {
    requirePage(document, pageId);
    return pageId;
  }
  const first = document.pages[0];
  if (!first) throw new Error("document has no pages");
  return first.id;
}
function elementAabbRecord(el) {
  const aabb = elementAabb(el);
  return { x: aabb.x, y: aabb.y, width: aabb.width, height: aabb.height };
}
function pageSnapshot(page) {
  return {
    id: page.id,
    name: page.name,
    width: page.width,
    height: page.height,
    background: page.background,
    bleed: page.bleed,
    element_count: page.elements.length,
    elements: page.elements.map((el) => ({
      id: el.id,
      kind: el.kind,
      name: el.name,
      aabb: elementAabbRecord(el),
      rotation: el.rotation,
      opacity: el.opacity,
      locked: el.locked,
      visible: el.visible,
      ...el.slot ? { slot: el.slot } : {}
    }))
  };
}
async function applyPlan(store, mintId, summary, operations) {
  const plan = { summary, operations };
  const { record } = await storeApplyScenePlan(store, plan, { actorKind: "agent_edit", mintId });
  return { rev: record.rev, operation_count: operations.length };
}
function collectPageSlotAttrs(page) {
  const slots = /* @__PURE__ */ new Map();
  const stack = [...page.elements];
  while (stack.length > 0) {
    const el = stack.pop();
    if (el.slot) {
      if (slots.has(el.slot)) {
        throw new Error(`duplicate slot name "${el.slot}" on page ${page.id}`);
      }
      slots.set(el.slot, { elementId: el.id, kind: el.kind });
    }
    if (el.kind === "group") stack.push(...el.children);
  }
  return slots;
}
function objectSchema(properties, required) {
  return { type: "object", properties, required, additionalProperties: false };
}
var pageIdProp = { type: "string", description: "Page id to target. Omit to target the first page." };
var elementIdProp = { type: "string", description: "Element id to target." };
var xProp = { type: "number", description: "X position in page coordinates (px)." };
var yProp = { type: "number", description: "Y position in page coordinates (px)." };
var widthProp = { type: "number", description: "Width in px (must be > 0)." };
var heightProp = { type: "number", description: "Height in px (must be > 0)." };
var colorProp = (label) => ({ type: "string", description: `${label} \u2014 hex (#rrggbb), rgb(), rgba(), or "transparent".` });
var CANVAS_MCP_TOOLS = [
  // ─── read ────────────────────────────────────────────────────────────────
  {
    name: "get_scene_state",
    description: "Read the full scene document: title, settings, all pages with dimensions and background, and every element with its axis-aligned bounding box (so you can reason about layout and overlap without rendering). Call this before editing to get real page and element ids.",
    inputSchema: objectSchema({}, []),
    async run(_args, env) {
      const { document, rev } = await env.store.getDocument();
      return {
        rev,
        title: document.title,
        schema_version: document.schemaVersion,
        settings: document.settings,
        pages: document.pages.map(pageSnapshot)
      };
    }
  },
  {
    name: "describe_page",
    description: "Read one page in detail: name, dimensions, background, bleed, guides, and every element with geometry, attributes, and slot bindings. Use this when you need attribute values (fill, font, src) the compact get_scene_state summary omits.",
    inputSchema: objectSchema(
      { page_id: pageIdProp },
      ["page_id"]
    ),
    async run(args, env) {
      const pageId = requireString(args, "page_id");
      const { document, rev } = await env.store.getDocument();
      const page = requirePage(document, pageId);
      return {
        rev,
        id: page.id,
        name: page.name,
        width: page.width,
        height: page.height,
        background: page.background,
        bleed: page.bleed,
        guides: page.guides,
        elements: page.elements.map((el) => ({ ...el, aabb: elementAabbRecord(el) }))
      };
    }
  },
  {
    name: "list_decisions",
    description: "List recent agent decisions recorded against this document. Useful to audit what the agent has already done this session.",
    inputSchema: objectSchema(
      { limit: { type: "number", description: "Max decisions to return (default 20, max 100)." } },
      []
    ),
    async run(args, env) {
      const limitRaw = optionalNumber(args, "limit") ?? 20;
      const limit = Math.min(100, Math.max(1, Math.round(limitRaw)));
      const decisions = await env.store.listDecisions(limit);
      return { decisions };
    }
  },
  // ─── add convenience wrappers ─────────────────────────────────────────────
  {
    name: "add_text",
    description: "Place a text element on a page. The element id is minted server-side and returned. x/y are the top-left in page coordinates (px). width sets the wrap column; height derives from content at render time.",
    inputSchema: objectSchema(
      {
        page_id: pageIdProp,
        text: { type: "string", description: "Initial text content." },
        x: xProp,
        y: yProp,
        width: widthProp,
        font_size: { type: "number", description: "Font size in px (must be > 0). Default 24." },
        font_family: { type: "string", description: 'CSS font family. Default "Inter".' },
        font_style: { type: "string", enum: ["normal", "bold", "italic", "bold italic"], description: 'Default "normal".' },
        fill: colorProp('Text color. Default "#000000".'),
        align: { type: "string", enum: ["left", "center", "right"], description: 'Default "left".' },
        line_height: { type: "number", description: "Line height multiplier. Default 1.2." },
        letter_spacing: { type: "number", description: "Letter spacing in px. Default 0." },
        name: { type: "string", description: "Layer name. Defaults to the first 32 chars of text." },
        slot: { type: "string", description: "Template slot name \u2014 allows apply_data to replace this text programmatically." }
      },
      ["text", "x", "y", "width"]
    ),
    async run(args, env) {
      const { document } = await env.store.getDocument();
      const pageId = resolvePageId(document, args);
      const id = env.mintId();
      const text = requireString(args, "text");
      const element = {
        id,
        kind: "text",
        name: optionalString(args, "name") ?? text.slice(0, 32),
        x: requireNumber(args, "x"),
        y: requireNumber(args, "y"),
        width: requireNumber(args, "width"),
        text,
        fontFamily: optionalString(args, "font_family") ?? "Inter",
        fontSize: optionalNumber(args, "font_size") ?? 24,
        fontStyle: optionalEnum(args, "font_style", ["normal", "bold", "italic", "bold italic"]) ?? "normal",
        fill: optionalString(args, "fill") ?? "#000000",
        align: optionalEnum(args, "align", ["left", "center", "right"]) ?? "left",
        lineHeight: optionalNumber(args, "line_height") ?? 1.2,
        letterSpacing: optionalNumber(args, "letter_spacing") ?? 0,
        rotation: 0,
        opacity: 1,
        locked: false,
        visible: true,
        ...(() => {
          const s = optionalString(args, "slot");
          return s ? { slot: s } : {};
        })()
      };
      const result = await applyPlan(env.store, env.mintId, `add text "${text.slice(0, 40)}"`, [
        { type: "add_element", pageId, element }
      ]);
      return { element_id: id, ...result };
    }
  },
  {
    name: "add_image",
    description: "Place an image element on a page. src must be an http(s) URL or a rooted /api/ path \u2014 never a data: blob. The element id is minted server-side and returned.",
    inputSchema: objectSchema(
      {
        page_id: pageIdProp,
        src: { type: "string", description: "Image URL (https://...) or /api/ path." },
        x: xProp,
        y: yProp,
        width: widthProp,
        height: heightProp,
        fit: { type: "string", enum: ["fill", "cover", "contain"], description: 'How the source maps into the frame. Default "cover".' },
        name: { type: "string", description: 'Layer name. Default "Image".' },
        slot: { type: "string", description: "Template slot name \u2014 allows apply_data to swap this image's src." }
      },
      ["src", "x", "y", "width", "height"]
    ),
    async run(args, env) {
      const { document } = await env.store.getDocument();
      const pageId = resolvePageId(document, args);
      const id = env.mintId();
      const element = {
        id,
        kind: "image",
        name: optionalString(args, "name") ?? "Image",
        x: requireNumber(args, "x"),
        y: requireNumber(args, "y"),
        width: requireNumber(args, "width"),
        height: requireNumber(args, "height"),
        src: requireString(args, "src"),
        fit: optionalEnum(args, "fit", ["fill", "cover", "contain"]) ?? "cover",
        rotation: 0,
        opacity: 1,
        locked: false,
        visible: true,
        ...(() => {
          const s = optionalString(args, "slot");
          return s ? { slot: s } : {};
        })()
      };
      const result = await applyPlan(env.store, env.mintId, "add image element", [
        { type: "add_element", pageId, element }
      ]);
      return { element_id: id, ...result };
    }
  },
  {
    name: "add_shape",
    description: 'Place a geometric shape on a page. kind must be "rect", "ellipse", or "line". For line: provide points as a flat [x0,y0,x1,y1,...] array (relative to x,y); for rect/ellipse: provide width and height.',
    inputSchema: objectSchema(
      {
        page_id: pageIdProp,
        kind: { type: "string", enum: ["rect", "ellipse", "line"], description: "Shape type." },
        x: xProp,
        y: yProp,
        width: { type: "number", description: "Width in px (required for rect and ellipse)." },
        height: { type: "number", description: "Height in px (required for rect and ellipse)." },
        fill: colorProp('Fill color (rect/ellipse). Default "#cccccc".'),
        stroke: colorProp("Stroke/line color."),
        stroke_width: { type: "number", description: "Stroke width in px." },
        corner_radius: { type: "number", description: "Corner radius in px (rect only)." },
        points: {
          type: "array",
          items: { type: "number" },
          description: 'Flat [x0,y0,x1,y1,...] array for lines, relative to (x,y). Required for kind="line".'
        },
        name: { type: "string", description: "Layer name." }
      },
      ["kind", "x", "y"]
    ),
    async run(args, env) {
      const { document } = await env.store.getDocument();
      const pageId = resolvePageId(document, args);
      const id = env.mintId();
      const kind = requireEnum(args, "kind", ["rect", "ellipse", "line"]);
      const x = requireNumber(args, "x");
      const y = requireNumber(args, "y");
      let element;
      if (kind === "rect") {
        const rect = {
          id,
          kind,
          x,
          y,
          name: optionalString(args, "name") ?? "Rectangle",
          width: requireNumber(args, "width"),
          height: requireNumber(args, "height"),
          fill: optionalString(args, "fill") ?? "#cccccc",
          rotation: 0,
          opacity: 1,
          locked: false,
          visible: true,
          ...optionalString(args, "stroke") ? { stroke: optionalString(args, "stroke") } : {},
          ...optionalNumber(args, "stroke_width") !== void 0 ? { strokeWidth: optionalNumber(args, "stroke_width") } : {},
          ...optionalNumber(args, "corner_radius") !== void 0 ? { cornerRadius: optionalNumber(args, "corner_radius") } : {}
        };
        element = rect;
      } else if (kind === "ellipse") {
        const ellipse = {
          id,
          kind,
          x,
          y,
          name: optionalString(args, "name") ?? "Ellipse",
          width: requireNumber(args, "width"),
          height: requireNumber(args, "height"),
          fill: optionalString(args, "fill") ?? "#cccccc",
          rotation: 0,
          opacity: 1,
          locked: false,
          visible: true,
          ...optionalString(args, "stroke") ? { stroke: optionalString(args, "stroke") } : {},
          ...optionalNumber(args, "stroke_width") !== void 0 ? { strokeWidth: optionalNumber(args, "stroke_width") } : {}
        };
        element = ellipse;
      } else {
        const rawPoints = args["points"];
        if (!Array.isArray(rawPoints) || rawPoints.length < 4 || rawPoints.length % 2 !== 0) {
          throw new Error('points is required for kind="line" and must be a flat [x0,y0,...] array with \u2265 2 points');
        }
        const points = rawPoints;
        const line = {
          id,
          kind,
          x,
          y,
          points,
          name: optionalString(args, "name") ?? "Line",
          stroke: optionalString(args, "stroke") ?? "#000000",
          strokeWidth: optionalNumber(args, "stroke_width") ?? 2,
          rotation: 0,
          opacity: 1,
          locked: false,
          visible: true
        };
        element = line;
      }
      const result = await applyPlan(env.store, env.mintId, `add ${kind} shape`, [
        { type: "add_element", pageId, element }
      ]);
      return { element_id: id, ...result };
    }
  },
  {
    name: "add_video",
    description: "Place a video element on a page. Video renders and exports as its poster frame \u2014 motion belongs to the sequences surface. src must be an http(s) URL or /api/ path.",
    inputSchema: objectSchema(
      {
        page_id: pageIdProp,
        src: { type: "string", description: "Video URL (https://...) or /api/ path." },
        x: xProp,
        y: yProp,
        width: widthProp,
        height: heightProp,
        poster_src: { type: "string", description: "Poster frame URL shown before render. Optional." },
        name: { type: "string", description: 'Layer name. Default "Video".' }
      },
      ["src", "x", "y", "width", "height"]
    ),
    async run(args, env) {
      const { document } = await env.store.getDocument();
      const pageId = resolvePageId(document, args);
      const id = env.mintId();
      const element = {
        id,
        kind: "video",
        name: optionalString(args, "name") ?? "Video",
        x: requireNumber(args, "x"),
        y: requireNumber(args, "y"),
        width: requireNumber(args, "width"),
        height: requireNumber(args, "height"),
        src: requireString(args, "src"),
        rotation: 0,
        opacity: 1,
        locked: false,
        visible: true,
        ...(() => {
          const s = optionalString(args, "poster_src");
          return s ? { posterSrc: s } : {};
        })()
      };
      const result = await applyPlan(env.store, env.mintId, "add video element", [
        { type: "add_element", pageId, element }
      ]);
      return { element_id: id, ...result };
    }
  },
  // ─── mutations ────────────────────────────────────────────────────────────
  {
    name: "set_attrs",
    description: "Set one or more attributes on an existing element. Only provide the attrs you want to change \u2014 omitted attributes are unchanged. Attempting to change kind or id is an error. For convenience transforms (x/y/width/height/rotation) prefer move_element, resize_element, or rotate_element.",
    inputSchema: objectSchema(
      {
        page_id: pageIdProp,
        element_id: elementIdProp,
        attrs: {
          type: "object",
          description: "Attribute patch \u2014 any subset of the element's mutable fields.",
          additionalProperties: true
        }
      },
      ["page_id", "element_id", "attrs"]
    ),
    async run(args, env) {
      const pageId = requireString(args, "page_id");
      const elementId = requireString(args, "element_id");
      if (!isRecord(args["attrs"])) throw new Error("attrs must be an object");
      const attrs = args["attrs"];
      const result = await applyPlan(env.store, env.mintId, `set attrs on ${elementId}`, [
        { type: "set_attrs", pageId, elementId, attrs }
      ]);
      return result;
    }
  },
  {
    name: "move_element",
    description: "Move an element to a new (x, y) position in page coordinates. Sugar for set_attrs({x, y}).",
    inputSchema: objectSchema(
      { page_id: pageIdProp, element_id: elementIdProp, x: xProp, y: yProp },
      ["page_id", "element_id", "x", "y"]
    ),
    async run(args, env) {
      const pageId = requireString(args, "page_id");
      const elementId = requireString(args, "element_id");
      const x = requireNumber(args, "x");
      const y = requireNumber(args, "y");
      const result = await applyPlan(env.store, env.mintId, `move element ${elementId} to (${x}, ${y})`, [
        { type: "set_attrs", pageId, elementId, attrs: { x, y } }
      ]);
      return result;
    }
  },
  {
    name: "resize_element",
    description: "Resize an element by setting its width and height. Sugar for set_attrs({width, height}). Not valid on lines (use set_attrs with points instead).",
    inputSchema: objectSchema(
      { page_id: pageIdProp, element_id: elementIdProp, width: widthProp, height: heightProp },
      ["page_id", "element_id", "width", "height"]
    ),
    async run(args, env) {
      const pageId = requireString(args, "page_id");
      const elementId = requireString(args, "element_id");
      const width = requireNumber(args, "width");
      const height = requireNumber(args, "height");
      const result = await applyPlan(env.store, env.mintId, `resize element ${elementId} to ${width}\xD7${height}`, [
        { type: "set_attrs", pageId, elementId, attrs: { width, height } }
      ]);
      return result;
    }
  },
  {
    name: "rotate_element",
    description: "Set an element's rotation in degrees (clockwise, about the element's top-left origin). Sugar for set_attrs({rotation}).",
    inputSchema: objectSchema(
      {
        page_id: pageIdProp,
        element_id: elementIdProp,
        degrees: { type: "number", description: "Rotation in degrees (clockwise, 0\u2013360 or negative)." }
      },
      ["page_id", "element_id", "degrees"]
    ),
    async run(args, env) {
      const pageId = requireString(args, "page_id");
      const elementId = requireString(args, "element_id");
      const rotation = requireNumber(args, "degrees");
      const result = await applyPlan(env.store, env.mintId, `rotate element ${elementId} to ${rotation}\xB0`, [
        { type: "set_attrs", pageId, elementId, attrs: { rotation } }
      ]);
      return result;
    }
  },
  {
    name: "reorder_element",
    description: "Change an element's z-order within its owner (page root or parent group). toIndex is 0-based within the owner's element list: 0 = bottom, length-1 = top.",
    inputSchema: objectSchema(
      {
        page_id: pageIdProp,
        element_id: elementIdProp,
        to_index: { type: "number", description: "0-based target z-index within the element's owner." }
      },
      ["page_id", "element_id", "to_index"]
    ),
    async run(args, env) {
      const pageId = requireString(args, "page_id");
      const elementId = requireString(args, "element_id");
      const toIndex = optionalNonNegativeInteger(args, "to_index") ?? 0;
      const result = await applyPlan(env.store, env.mintId, `reorder element ${elementId} to index ${toIndex}`, [
        { type: "reorder_element", pageId, elementId, toIndex }
      ]);
      return result;
    }
  },
  {
    name: "delete_element",
    description: "Permanently delete an element (and all its children if it is a group) from a page.",
    inputSchema: objectSchema(
      { page_id: pageIdProp, element_id: elementIdProp },
      ["page_id", "element_id"]
    ),
    async run(args, env) {
      const pageId = requireString(args, "page_id");
      const elementId = requireString(args, "element_id");
      const result = await applyPlan(env.store, env.mintId, `delete element ${elementId}`, [
        { type: "delete_element", pageId, elementId }
      ]);
      return result;
    }
  },
  {
    name: "group_elements",
    description: "Group 2+ sibling elements into a new group. Elements must share the same owner (page root or the same parent group). The group's origin is set to the minimum bounding box of the members; children are rebased to group-local coordinates.",
    inputSchema: objectSchema(
      {
        page_id: pageIdProp,
        element_ids: { type: "array", items: { type: "string" }, minItems: 2, description: "\u22652 sibling element ids to group." },
        name: { type: "string", description: 'Layer name for the new group. Default "Group".' }
      },
      ["page_id", "element_ids"]
    ),
    async run(args, env) {
      const pageId = requireString(args, "page_id");
      const elementIds = requireStringArray(args, "element_ids");
      const groupId = env.mintId();
      const result = await applyPlan(env.store, env.mintId, `group ${elementIds.length} elements`, [
        { type: "group_elements", pageId, elementIds, groupId, name: optionalString(args, "name") }
      ]);
      return { group_id: groupId, ...result };
    }
  },
  {
    name: "ungroup_element",
    description: "Dissolve a group, promoting its children to the group's parent owner at page coordinates. The group element is removed.",
    inputSchema: objectSchema(
      { page_id: pageIdProp, group_id: { type: "string", description: "Id of the group element to ungroup." } },
      ["page_id", "group_id"]
    ),
    async run(args, env) {
      const pageId = requireString(args, "page_id");
      const groupId = requireString(args, "group_id");
      const result = await applyPlan(env.store, env.mintId, `ungroup ${groupId}`, [
        { type: "ungroup_element", pageId, groupId }
      ]);
      return result;
    }
  },
  // ─── page management ──────────────────────────────────────────────────────
  {
    name: "add_page",
    description: "Add a new blank page to the document. Returns the new page's id.",
    inputSchema: objectSchema(
      {
        name: { type: "string", description: "Page name." },
        width: { type: "number", description: "Width in px. Default 1080." },
        height: { type: "number", description: "Height in px. Default 1080." },
        background: colorProp('Page background. Default "#ffffff".'),
        index: { type: "number", description: "Position in the page list (0-based). Omit to append." }
      },
      []
    ),
    async run(args, env) {
      const pageId = env.mintId();
      const result = await applyPlan(env.store, env.mintId, "add page", [
        {
          type: "add_page",
          pageId,
          options: {
            name: optionalString(args, "name"),
            width: optionalNumber(args, "width"),
            height: optionalNumber(args, "height"),
            background: optionalString(args, "background")
          },
          index: optionalNonNegativeInteger(args, "index")
        }
      ]);
      return { page_id: pageId, ...result };
    }
  },
  {
    name: "duplicate_page",
    description: "Duplicate an existing page including all its elements. Element ids are re-minted server-side to avoid conflicts. Returns the new page's id.",
    inputSchema: objectSchema(
      {
        source_page_id: { type: "string", description: "Page id to copy." }
      },
      ["source_page_id"]
    ),
    async run(args, env) {
      const sourcePageId = requireString(args, "source_page_id");
      const pageId = env.mintId();
      const result = await applyPlan(env.store, env.mintId, `duplicate page ${sourcePageId}`, [
        { type: "duplicate_page", sourcePageId, pageId }
      ]);
      return { page_id: pageId, ...result };
    }
  },
  {
    name: "delete_page",
    description: "Delete a page. Fails if the document has only one page.",
    inputSchema: objectSchema(
      { page_id: { type: "string", description: "Page id to delete." } },
      ["page_id"]
    ),
    async run(args, env) {
      const pageId = requireString(args, "page_id");
      const result = await applyPlan(env.store, env.mintId, `delete page ${pageId}`, [
        { type: "delete_page", pageId }
      ]);
      return result;
    }
  },
  {
    name: "set_page_props",
    description: "Update a page's name, dimensions, background color, or bleed. Pass null for bleed to clear it. Omit fields you don't want to change.",
    inputSchema: objectSchema(
      {
        page_id: { type: "string", description: "Page id to update." },
        name: { type: "string", description: "New page name." },
        width: { type: "number", description: "New width in px." },
        height: { type: "number", description: "New height in px." },
        background: colorProp("New background color."),
        bleed: {
          type: "object",
          description: "Bleed extents in px drawn OUTSIDE the page trim edge. Pass null to clear bleed.",
          properties: {
            top: { type: "number" },
            right: { type: "number" },
            bottom: { type: "number" },
            left: { type: "number" }
          },
          required: ["top", "right", "bottom", "left"],
          nullable: true
        }
      },
      ["page_id"]
    ),
    async run(args, env) {
      const pageId = requireString(args, "page_id");
      let bleed;
      if ("bleed" in args) {
        if (args["bleed"] === null) {
          bleed = null;
        } else if (isRecord(args["bleed"])) {
          const b = args["bleed"];
          bleed = {
            top: requireNumber(b, "top"),
            right: requireNumber(b, "right"),
            bottom: requireNumber(b, "bottom"),
            left: requireNumber(b, "left")
          };
        } else {
          throw new Error("bleed must be an object with top/right/bottom/left or null to clear");
        }
      }
      const result = await applyPlan(env.store, env.mintId, `set props on page ${pageId}`, [
        {
          type: "set_page_props",
          pageId,
          name: optionalString(args, "name"),
          width: optionalNumber(args, "width"),
          height: optionalNumber(args, "height"),
          background: optionalString(args, "background"),
          ...bleed !== void 0 ? { bleed } : {}
        }
      ]);
      return result;
    }
  },
  {
    name: "set_page_guides",
    description: "Set ruler guides on a page. Replaces ALL existing guides for that axis \u2014 pass the full updated arrays.",
    inputSchema: objectSchema(
      {
        page_id: { type: "string", description: "Page id to update." },
        vertical: { type: "array", items: { type: "number" }, description: "Vertical guide positions in page-coordinate px." },
        horizontal: { type: "array", items: { type: "number" }, description: "Horizontal guide positions in page-coordinate px." }
      },
      ["page_id", "vertical", "horizontal"]
    ),
    async run(args, env) {
      const pageId = requireString(args, "page_id");
      if (!Array.isArray(args["vertical"])) throw new Error("vertical must be an array of numbers");
      if (!Array.isArray(args["horizontal"])) throw new Error("horizontal must be an array of numbers");
      const vertical = args["vertical"];
      const horizontal = args["horizontal"];
      const result = await applyPlan(env.store, env.mintId, `set guides on page ${pageId}`, [
        { type: "set_page_guides", pageId, guides: { vertical, horizontal } }
      ]);
      return result;
    }
  },
  // ─── template / data binding ──────────────────────────────────────────────
  {
    name: "bind_slot",
    description: "Bind or unbind a template slot name to an element. Slot names are unique document-wide. Text elements accept string data; image/video elements accept src URLs. Pass null for slot to unbind.",
    inputSchema: objectSchema(
      {
        page_id: pageIdProp,
        element_id: elementIdProp,
        slot: { type: ["string", "null"], description: "Slot name to bind, or null to unbind." }
      },
      ["page_id", "element_id", "slot"]
    ),
    async run(args, env) {
      const pageId = requireString(args, "page_id");
      const elementId = requireString(args, "element_id");
      const slot = args["slot"] === null ? null : requireString(args, "slot");
      const result = await applyPlan(env.store, env.mintId, `bind slot "${slot}" to ${elementId}`, [
        { type: "bind_slot", pageId, elementId, slot }
      ]);
      return result;
    }
  },
  {
    name: "apply_data",
    description: "Fill template slots with data. bindings is a {slot_name: value} map. Text slots accept any string; image/video slots accept http(s) URLs or /api/ paths; unknown slot names throw. Partial application is allowed.",
    inputSchema: objectSchema(
      {
        bindings: {
          type: "object",
          description: "Map of slot name \u2192 value. Text slots: string. Image/video slots: URL.",
          additionalProperties: { type: "string" }
        }
      },
      ["bindings"]
    ),
    async run(args, env) {
      if (!isRecord(args["bindings"])) throw new Error("bindings must be an object");
      const bindings = args["bindings"];
      const result = await applyPlan(env.store, env.mintId, `apply data to ${Object.keys(bindings).length} slots`, [
        { type: "apply_data", bindings }
      ]);
      return result;
    }
  },
  {
    name: "instantiate_template",
    description: "Clone this document's page(s) with freshly minted element ids and fill the declared slots with the provided data bindings in one atomic call. Use this to produce personalized copies of a template document without modifying the original. Returns the new page ids in order. Note: this mutates the SAME document by appending copies of the requested pages with re-minted ids and applying data \u2014 it does NOT create a separate document. After calling, the document contains both the original pages and the new copies.",
    inputSchema: objectSchema(
      {
        source_page_ids: {
          type: "array",
          items: { type: "string" },
          description: "Page ids to clone. Omit to clone all pages."
        },
        bindings: {
          type: "object",
          description: "Slot name \u2192 value map applied after cloning.",
          additionalProperties: { type: "string" }
        }
      },
      []
    ),
    async run(args, env) {
      const { document } = await env.store.getDocument();
      const rawSourceIds = Array.isArray(args["source_page_ids"]) ? args["source_page_ids"] : document.pages.map((p) => p.id);
      const bindings = optionalRecord(args, "bindings") ?? {};
      if (rawSourceIds.length === 0) throw new Error("source_page_ids must not be empty");
      const unbindOps = [];
      const rebindOps = [];
      const dupOps = [];
      const newPageIds = [];
      for (const sourcePageId of rawSourceIds) {
        const sourcePage = requirePage(document, sourcePageId);
        const sourceSlots = collectPageSlotAttrs(sourcePage);
        for (const [slotName, { elementId }] of sourceSlots) {
          unbindOps.push({ type: "bind_slot", pageId: sourcePageId, elementId, slot: null });
          rebindOps.push({ type: "bind_slot", pageId: sourcePageId, elementId, slot: slotName });
        }
        const pageId = env.mintId();
        newPageIds.push(pageId);
        dupOps.push({ type: "duplicate_page", sourcePageId, pageId });
      }
      const applyDataOps = Object.keys(bindings).length > 0 ? [{ type: "apply_data", bindings }] : [];
      const allOps = [
        ...dupOps,
        ...unbindOps,
        ...applyDataOps,
        ...rebindOps
      ];
      const result = await applyPlan(
        env.store,
        env.mintId,
        `instantiate template (${rawSourceIds.length} pages)`,
        allOps
      );
      return { new_page_ids: newPageIds, ...result };
    }
  },
  // ─── exports ──────────────────────────────────────────────────────────────
  {
    name: "create_export",
    description: 'Queue a document export. For "png" and "jpeg", a render job is queued and status starts as "queued" \u2014 the host renders the Konva canvas and uploads the result. For "json", the export completes immediately with the full document JSON in metadata. Returns the export record id and initial status.',
    inputSchema: objectSchema(
      {
        format: { type: "string", enum: ["png", "jpeg", "json"], description: "Export format." },
        page_id: { type: "string", description: "Page to export. Omit to export all pages (first page for images)." },
        pixel_ratio: { type: "number", description: "Device pixel ratio for raster exports. Default 1." }
      },
      ["format"]
    ),
    async run(args, env) {
      const format = requireEnum(args, "format", ["png", "jpeg", "json"]);
      const pageId = optionalString(args, "page_id");
      const pixelRatio = optionalNumber(args, "pixel_ratio") ?? 1;
      let metadata = {
        pageId: pageId ?? null,
        pixelRatio
      };
      if (format === "json") {
        const { document, rev } = await env.store.getDocument();
        metadata = { ...metadata, document, rev };
      }
      const exportRecord = await env.store.createExport(format, metadata);
      await env.store.recordDecision({
        kind: "export",
        instruction: `create ${format} export${pageId ? ` for page ${pageId}` : ""}`,
        metadata: { tool: "create_export", export_id: exportRecord.id, format }
      });
      return {
        export_id: exportRecord.id,
        format: exportRecord.format,
        status: exportRecord.status,
        metadata: exportRecord.metadata,
        created_at: exportRecord.createdAt
      };
    }
  }
];
function findCanvasMcpTool(name) {
  return CANVAS_MCP_TOOLS.find((tool) => tool.name === name);
}
var CANVAS_MCP_TOOL_NAMES = CANVAS_MCP_TOOLS.map((t) => t.name);
var CANVAS_ELEMENT_KINDS = SCENE_ELEMENT_KINDS;

// src/design-canvas/mcp-handler.ts
function createDesignCanvasMcpHandler(opts) {
  const serverInfo = opts.serverInfo ?? { name: "design-canvas", version: "1.0.0" };
  return createMcpToolHandler({
    serverInfo,
    tools: CANVAS_MCP_TOOLS,
    buildEnv: (_request) => ({ store: opts.store, mintId: opts.mintId })
  });
}

// src/design-canvas/mcp-entry.ts
var DEFAULT_DESIGN_CANVAS_MCP_DESCRIPTION = "Live visual asset editor for the current design document: read scene state, add/move/resize/delete elements, manage pages, bind template slots, apply data, and queue exports. All coordinates are CSS pixels.";
function buildDesignCanvasMcpServerEntry(opts) {
  return buildScopedMcpServerEntry({
    ...opts,
    label: "buildDesignCanvasMcpServerEntry",
    defaultDescription: DEFAULT_DESIGN_CANVAS_MCP_DESCRIPTION
  });
}
export {
  CANVAS_ELEMENT_KINDS,
  CANVAS_MCP_TOOLS,
  CANVAS_MCP_TOOL_NAMES,
  CHANNEL_PRESETS,
  DEFAULT_DESIGN_CANVAS_MCP_DESCRIPTION,
  EXPORT_PRESETS,
  SCENE_ELEMENT_KINDS,
  SCENE_OPERATION_TYPES,
  SCENE_SCHEMA_VERSION,
  SIZE_PRESETS,
  applyBindingsToDocument,
  applySceneOperation,
  applySceneOperations,
  assertColor,
  assertFinite,
  assertPositiveFinite,
  assertSceneMediaSrc,
  bleedAwareExportBounds,
  bleedAwareExportRect,
  boundsIntersect,
  buildDesignCanvasMcpServerEntry,
  collectSlots,
  createDesignCanvasMcpHandler,
  createEmptyDocument,
  createPage,
  elementAabb,
  elementExtent,
  estimateTextHeight,
  findCanvasMcpTool,
  findElement,
  findPreset,
  instantiateTemplate,
  listTemplateSlots,
  matchPreset,
  requireChannelPreset,
  requireElement,
  requirePage,
  scaleForPreset,
  scalePageForChannelPreset,
  storeApplyScenePlan,
  validateBindings,
  validateSceneOperation,
  validateSceneOperations,
  validateSlotValue
};
//# sourceMappingURL=index.js.map