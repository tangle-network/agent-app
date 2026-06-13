/**
 * Design-canvas MCP tool registry — what the in-sandbox agent sees over the
 * live agent→canvas channel. Each entry carries an LLM-facing description, a
 * JSON Schema for the arguments, and the typed dispatch that validates the
 * resulting operations, applies them through the store, and records ONE
 * decision row per mutating call.
 *
 * Every mutation: validate → apply via storeApplyScenePlan → recordDecision.
 * Throws anywhere become isError results the model reads to correct its call.
 *
 * Convenience sugar tools (add_text, move_element, etc.) expand to the
 * underlying operation primitives before reaching the kernel — no separate
 * code path to drift.
 */

import { elementAabb, requirePage, SCENE_ELEMENT_KINDS } from './model'
import { lintSceneDocument, lintScenePage } from './lint'
import { THEME_PACKS, requireThemePack } from './themes'
import { ARCHETYPE_DESCRIPTORS, buildArchetype } from './archetypes'
import type {
  RectElement,
  EllipseElement,
  LineElement,
  TextElement,
  ImageElement,
  VideoElement,
  SceneDocument,
  SceneElement,
  ScenePage,
} from './model'
import type { SceneOperation, ScenePlan } from './operations'
import type { SceneStore } from './store'
import { storeApplyScenePlan } from './apply'
import type { McpToolDefinition } from '../tools/mcp-rpc'

// ---------------------------------------------------------------------------
// Tool env
// ---------------------------------------------------------------------------

export interface DesignCanvasMcpToolEnv {
  store: SceneStore
  mintId: () => string
}

// ---------------------------------------------------------------------------
// Argument readers — fail loud with name + expected type
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} is required and must be a non-empty string`)
  }
  return value
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${name} must be a string when provided`)
  return value
}

function requireNumber(args: Record<string, unknown>, name: string): number {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} is required and must be a finite number`)
  }
  return value
}

function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number when provided`)
  }
  return value
}

function optionalBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean when provided`)
  return value
}

function optionalNonNegativeInteger(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer when provided`)
  }
  return value
}

function requireStringArray(args: Record<string, unknown>, name: string): string[] {
  const value = args[name]
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'string')) {
    throw new Error(`${name} is required and must be a non-empty array of strings`)
  }
  return value as string[]
}

function optionalRecord(args: Record<string, unknown>, name: string): Record<string, string> | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (!isRecord(value) || Object.values(value).some((v) => typeof v !== 'string')) {
    throw new Error(`${name} must be an object mapping string keys to string values when provided`)
  }
  return value as Record<string, string>
}

function requireEnum<T extends string>(args: Record<string, unknown>, name: string, values: readonly T[]): T {
  const value = args[name]
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of: ${values.join(', ')}`)
  }
  return value as T
}

function optionalEnum<T extends string>(args: Record<string, unknown>, name: string, values: readonly T[]): T | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  return requireEnum(args, name, values)
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Pick the first page id when the caller omits page_id. */
function resolvePageId(document: SceneDocument, args: Record<string, unknown>): string {
  const pageId = optionalString(args, 'page_id')
  if (pageId) {
    requirePage(document, pageId)
    return pageId
  }
  const first = document.pages[0]
  if (!first) throw new Error('document has no pages')
  return first.id
}

function elementAabbRecord(el: SceneElement) {
  const aabb = elementAabb(el)
  return { x: aabb.x, y: aabb.y, width: aabb.width, height: aabb.height }
}

function pageSnapshot(page: ScenePage) {
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
      ...(el.slot ? { slot: el.slot } : {}),
    })),
  }
}

async function applyPlan(
  store: SceneStore,
  mintId: () => string,
  summary: string,
  operations: SceneOperation[],
): Promise<{ rev: number; operation_count: number }> {
  const plan: ScenePlan = { summary, operations }
  const { record } = await storeApplyScenePlan(store, plan, { actorKind: 'agent_edit', mintId })
  return { rev: record.rev, operation_count: operations.length }
}

/** Collect slot→elementId mapping for a SINGLE page (no cross-page slot walk,
 *  so duplicate slot names across different pages don't cause an error). */
function collectPageSlotAttrs(page: ScenePage): Map<string, { elementId: string; kind: SceneElement['kind'] }> {
  const slots = new Map<string, { elementId: string; kind: SceneElement['kind'] }>()
  const stack = [...page.elements]
  while (stack.length > 0) {
    const el = stack.pop()!
    if (el.slot) {
      if (slots.has(el.slot)) {
        throw new Error(`duplicate slot name "${el.slot}" on page ${page.id}`)
      }
      slots.set(el.slot, { elementId: el.id, kind: el.kind })
    }
    if (el.kind === 'group') stack.push(...el.children)
  }
  return slots
}


// ---------------------------------------------------------------------------
// JSON Schema helpers
// ---------------------------------------------------------------------------

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false }
}

const pageIdProp = { type: 'string', description: 'Page id to target. Omit to target the first page.' }
const elementIdProp = { type: 'string', description: 'Element id to target.' }
const xProp = { type: 'number', description: 'X position in page coordinates (px).' }
const yProp = { type: 'number', description: 'Y position in page coordinates (px).' }
const widthProp = { type: 'number', description: 'Width in px (must be > 0).' }
const heightProp = { type: 'number', description: 'Height in px (must be > 0).' }
const colorProp = (label: string) => ({ type: 'string', description: `${label} — hex (#rrggbb), rgb(), rgba(), or "transparent".` })

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

const CANVAS_MCP_TOOLS: McpToolDefinition<DesignCanvasMcpToolEnv>[] = [

  // ─── read ────────────────────────────────────────────────────────────────

  {
    name: 'get_scene_state',
    description:
      'Read the full scene document: title, settings, all pages with dimensions and background, and every element with its axis-aligned bounding box (so you can reason about layout and overlap without rendering). Call this before editing to get real page and element ids.',
    inputSchema: objectSchema({}, []),
    async run(_args, env) {
      const { document, rev } = await env.store.getDocument()
      return {
        rev,
        title: document.title,
        schema_version: document.schemaVersion,
        settings: document.settings,
        pages: document.pages.map(pageSnapshot),
      }
    },
  },

  {
    name: 'describe_page',
    description:
      'Read one page in detail: name, dimensions, background, bleed, guides, and every element with geometry, attributes, and slot bindings. Use this when you need attribute values (fill, font, src) the compact get_scene_state summary omits.',
    inputSchema: objectSchema(
      { page_id: pageIdProp },
      ['page_id'],
    ),
    async run(args, env) {
      const pageId = requireString(args, 'page_id')
      const { document, rev } = await env.store.getDocument()
      const page = requirePage(document, pageId)
      return {
        rev,
        id: page.id,
        name: page.name,
        width: page.width,
        height: page.height,
        background: page.background,
        bleed: page.bleed,
        guides: page.guides,
        elements: page.elements.map((el) => ({ ...el, aabb: elementAabbRecord(el) })),
      }
    },
  },

  {
    name: 'list_decisions',
    description: 'List recent agent decisions recorded against this document. Useful to audit what the agent has already done this session.',
    inputSchema: objectSchema(
      { limit: { type: 'number', description: 'Max decisions to return (default 20, max 100).' } },
      [],
    ),
    async run(args, env) {
      const limitRaw = optionalNumber(args, 'limit') ?? 20
      const limit = Math.min(100, Math.max(1, Math.round(limitRaw)))
      const decisions = await env.store.listDecisions(limit)
      return { decisions }
    },
  },

  // ─── add convenience wrappers ─────────────────────────────────────────────

  {
    name: 'add_text',
    description:
      'Place a text element on a page. The element id is minted server-side and returned. x/y are the top-left in page coordinates (px). width sets the wrap column; height derives from content at render time.',
    inputSchema: objectSchema(
      {
        page_id: pageIdProp,
        text: { type: 'string', description: 'Initial text content.' },
        x: xProp,
        y: yProp,
        width: widthProp,
        font_size: { type: 'number', description: 'Font size in px (must be > 0). Default 24.' },
        font_family: { type: 'string', description: 'CSS font family. Default "Inter".' },
        font_style: { type: 'string', enum: ['normal', 'bold', 'italic', 'bold italic'], description: 'Default "normal".' },
        fill: colorProp('Text color. Default "#000000".'),
        align: { type: 'string', enum: ['left', 'center', 'right'], description: 'Default "left".' },
        line_height: { type: 'number', description: 'Line height multiplier. Default 1.2.' },
        letter_spacing: { type: 'number', description: 'Letter spacing in px. Default 0.' },
        name: { type: 'string', description: 'Layer name. Defaults to the first 32 chars of text.' },
        slot: { type: 'string', description: 'Template slot name — allows apply_data to replace this text programmatically.' },
      },
      ['text', 'x', 'y', 'width'],
    ),
    async run(args, env) {
      const { document } = await env.store.getDocument()
      const pageId = resolvePageId(document, args)
      const id = env.mintId()
      const text = requireString(args, 'text')
      const element: TextElement = {
        id,
        kind: 'text',
        name: optionalString(args, 'name') ?? text.slice(0, 32),
        x: requireNumber(args, 'x'),
        y: requireNumber(args, 'y'),
        width: requireNumber(args, 'width'),
        text,
        fontFamily: optionalString(args, 'font_family') ?? 'Inter',
        fontSize: optionalNumber(args, 'font_size') ?? 24,
        fontStyle: optionalEnum(args, 'font_style', ['normal', 'bold', 'italic', 'bold italic'] as const) ?? 'normal',
        fill: optionalString(args, 'fill') ?? '#000000',
        align: optionalEnum(args, 'align', ['left', 'center', 'right'] as const) ?? 'left',
        lineHeight: optionalNumber(args, 'line_height') ?? 1.2,
        letterSpacing: optionalNumber(args, 'letter_spacing') ?? 0,
        rotation: 0,
        opacity: 1,
        locked: false,
        visible: true,
        ...(() => { const s = optionalString(args, 'slot'); return s ? { slot: s } : {} })(),
      }
      const result = await applyPlan(env.store, env.mintId, `add text "${text.slice(0, 40)}"`, [
        { type: 'add_element', pageId, element },
      ])
      return { element_id: id, ...result }
    },
  },

  {
    name: 'add_image',
    description:
      'Place an image element on a page. src must be an http(s) URL or a rooted /api/ path — never a data: blob. The element id is minted server-side and returned.',
    inputSchema: objectSchema(
      {
        page_id: pageIdProp,
        src: { type: 'string', description: 'Image URL (https://...) or /api/ path.' },
        x: xProp,
        y: yProp,
        width: widthProp,
        height: heightProp,
        fit: { type: 'string', enum: ['fill', 'cover', 'contain'], description: 'How the source maps into the frame. Default "cover".' },
        name: { type: 'string', description: 'Layer name. Default "Image".' },
        slot: { type: 'string', description: 'Template slot name — allows apply_data to swap this image\'s src.' },
      },
      ['src', 'x', 'y', 'width', 'height'],
    ),
    async run(args, env) {
      const { document } = await env.store.getDocument()
      const pageId = resolvePageId(document, args)
      const id = env.mintId()
      const element: ImageElement = {
        id,
        kind: 'image',
        name: optionalString(args, 'name') ?? 'Image',
        x: requireNumber(args, 'x'),
        y: requireNumber(args, 'y'),
        width: requireNumber(args, 'width'),
        height: requireNumber(args, 'height'),
        src: requireString(args, 'src'),
        fit: optionalEnum(args, 'fit', ['fill', 'cover', 'contain'] as const) ?? 'cover',
        rotation: 0,
        opacity: 1,
        locked: false,
        visible: true,
        ...(() => { const s = optionalString(args, 'slot'); return s ? { slot: s } : {} })(),
      }
      const result = await applyPlan(env.store, env.mintId, 'add image element', [
        { type: 'add_element', pageId, element },
      ])
      return { element_id: id, ...result }
    },
  },

  {
    name: 'add_shape',
    description:
      'Place a geometric shape on a page. kind must be "rect", "ellipse", or "line". For line: provide points as a flat [x0,y0,x1,y1,...] array (relative to x,y); for rect/ellipse: provide width and height.',
    inputSchema: objectSchema(
      {
        page_id: pageIdProp,
        kind: { type: 'string', enum: ['rect', 'ellipse', 'line'], description: 'Shape type.' },
        x: xProp,
        y: yProp,
        width: { type: 'number', description: 'Width in px (required for rect and ellipse).' },
        height: { type: 'number', description: 'Height in px (required for rect and ellipse).' },
        fill: colorProp('Fill color (rect/ellipse). Default "#cccccc".'),
        stroke: colorProp('Stroke/line color.'),
        stroke_width: { type: 'number', description: 'Stroke width in px.' },
        corner_radius: { type: 'number', description: 'Corner radius in px (rect only).' },
        points: {
          type: 'array',
          items: { type: 'number' },
          description: 'Flat [x0,y0,x1,y1,...] array for lines, relative to (x,y). Required for kind="line".',
        },
        name: { type: 'string', description: 'Layer name.' },
      },
      ['kind', 'x', 'y'],
    ),
    async run(args, env) {
      const { document } = await env.store.getDocument()
      const pageId = resolvePageId(document, args)
      const id = env.mintId()
      const kind = requireEnum(args, 'kind', ['rect', 'ellipse', 'line'] as const)
      const x = requireNumber(args, 'x')
      const y = requireNumber(args, 'y')
      let element: SceneElement
      if (kind === 'rect') {
        const rect: RectElement = {
          id, kind, x, y,
          name: optionalString(args, 'name') ?? 'Rectangle',
          width: requireNumber(args, 'width'),
          height: requireNumber(args, 'height'),
          fill: optionalString(args, 'fill') ?? '#cccccc',
          rotation: 0, opacity: 1, locked: false, visible: true,
          ...(optionalString(args, 'stroke') ? { stroke: optionalString(args, 'stroke') } : {}),
          ...(optionalNumber(args, 'stroke_width') !== undefined ? { strokeWidth: optionalNumber(args, 'stroke_width') } : {}),
          ...(optionalNumber(args, 'corner_radius') !== undefined ? { cornerRadius: optionalNumber(args, 'corner_radius') } : {}),
        }
        element = rect
      } else if (kind === 'ellipse') {
        const ellipse: EllipseElement = {
          id, kind, x, y,
          name: optionalString(args, 'name') ?? 'Ellipse',
          width: requireNumber(args, 'width'),
          height: requireNumber(args, 'height'),
          fill: optionalString(args, 'fill') ?? '#cccccc',
          rotation: 0, opacity: 1, locked: false, visible: true,
          ...(optionalString(args, 'stroke') ? { stroke: optionalString(args, 'stroke') } : {}),
          ...(optionalNumber(args, 'stroke_width') !== undefined ? { strokeWidth: optionalNumber(args, 'stroke_width') } : {}),
        }
        element = ellipse
      } else {
        const rawPoints = args['points']
        if (!Array.isArray(rawPoints) || rawPoints.length < 4 || rawPoints.length % 2 !== 0) {
          throw new Error('points is required for kind="line" and must be a flat [x0,y0,...] array with ≥ 2 points')
        }
        const points = rawPoints as number[]
        const line: LineElement = {
          id, kind, x, y, points,
          name: optionalString(args, 'name') ?? 'Line',
          stroke: optionalString(args, 'stroke') ?? '#000000',
          strokeWidth: optionalNumber(args, 'stroke_width') ?? 2,
          rotation: 0, opacity: 1, locked: false, visible: true,
        }
        element = line
      }
      const result = await applyPlan(env.store, env.mintId, `add ${kind} shape`, [
        { type: 'add_element', pageId, element },
      ])
      return { element_id: id, ...result }
    },
  },

  {
    name: 'add_video',
    description:
      'Place a video element on a page. Video renders and exports as its poster frame — motion belongs to the sequences surface. src must be an http(s) URL or /api/ path.',
    inputSchema: objectSchema(
      {
        page_id: pageIdProp,
        src: { type: 'string', description: 'Video URL (https://...) or /api/ path.' },
        x: xProp,
        y: yProp,
        width: widthProp,
        height: heightProp,
        poster_src: { type: 'string', description: 'Poster frame URL shown before render. Optional.' },
        name: { type: 'string', description: 'Layer name. Default "Video".' },
      },
      ['src', 'x', 'y', 'width', 'height'],
    ),
    async run(args, env) {
      const { document } = await env.store.getDocument()
      const pageId = resolvePageId(document, args)
      const id = env.mintId()
      const element: VideoElement = {
        id,
        kind: 'video',
        name: optionalString(args, 'name') ?? 'Video',
        x: requireNumber(args, 'x'),
        y: requireNumber(args, 'y'),
        width: requireNumber(args, 'width'),
        height: requireNumber(args, 'height'),
        src: requireString(args, 'src'),
        rotation: 0,
        opacity: 1,
        locked: false,
        visible: true,
        ...(() => { const s = optionalString(args, 'poster_src'); return s ? { posterSrc: s } : {} })(),
      }
      const result = await applyPlan(env.store, env.mintId, 'add video element', [
        { type: 'add_element', pageId, element },
      ])
      return { element_id: id, ...result }
    },
  },

  // ─── mutations ────────────────────────────────────────────────────────────

  {
    name: 'set_attrs',
    description:
      'Set one or more attributes on an existing element. Only provide the attrs you want to change — omitted attributes are unchanged. Attempting to change kind or id is an error. For convenience transforms (x/y/width/height/rotation) prefer move_element, resize_element, or rotate_element.',
    inputSchema: objectSchema(
      {
        page_id: pageIdProp,
        element_id: elementIdProp,
        attrs: {
          type: 'object',
          description: 'Attribute patch — any subset of the element\'s mutable fields.',
          additionalProperties: true,
        },
      },
      ['page_id', 'element_id', 'attrs'],
    ),
    async run(args, env) {
      const pageId = requireString(args, 'page_id')
      const elementId = requireString(args, 'element_id')
      if (!isRecord(args['attrs'])) throw new Error('attrs must be an object')
      const attrs = args['attrs'] as Record<string, unknown>
      const result = await applyPlan(env.store, env.mintId, `set attrs on ${elementId}`, [
        { type: 'set_attrs', pageId, elementId, attrs: attrs as import('./operations').SceneAttrsPatch },
      ])
      return result
    },
  },

  {
    name: 'move_element',
    description: 'Move an element to a new (x, y) position in page coordinates. Sugar for set_attrs({x, y}).',
    inputSchema: objectSchema(
      { page_id: pageIdProp, element_id: elementIdProp, x: xProp, y: yProp },
      ['page_id', 'element_id', 'x', 'y'],
    ),
    async run(args, env) {
      const pageId = requireString(args, 'page_id')
      const elementId = requireString(args, 'element_id')
      const x = requireNumber(args, 'x')
      const y = requireNumber(args, 'y')
      const result = await applyPlan(env.store, env.mintId, `move element ${elementId} to (${x}, ${y})`, [
        { type: 'set_attrs', pageId, elementId, attrs: { x, y } },
      ])
      return result
    },
  },

  {
    name: 'resize_element',
    description: 'Resize an element by setting its width and height. Sugar for set_attrs({width, height}). Not valid on lines (use set_attrs with points instead).',
    inputSchema: objectSchema(
      { page_id: pageIdProp, element_id: elementIdProp, width: widthProp, height: heightProp },
      ['page_id', 'element_id', 'width', 'height'],
    ),
    async run(args, env) {
      const pageId = requireString(args, 'page_id')
      const elementId = requireString(args, 'element_id')
      const width = requireNumber(args, 'width')
      const height = requireNumber(args, 'height')
      const result = await applyPlan(env.store, env.mintId, `resize element ${elementId} to ${width}×${height}`, [
        { type: 'set_attrs', pageId, elementId, attrs: { width, height } },
      ])
      return result
    },
  },

  {
    name: 'rotate_element',
    description: 'Set an element\'s rotation in degrees (clockwise, about the element\'s top-left origin). Sugar for set_attrs({rotation}).',
    inputSchema: objectSchema(
      {
        page_id: pageIdProp,
        element_id: elementIdProp,
        degrees: { type: 'number', description: 'Rotation in degrees (clockwise, 0–360 or negative).' },
      },
      ['page_id', 'element_id', 'degrees'],
    ),
    async run(args, env) {
      const pageId = requireString(args, 'page_id')
      const elementId = requireString(args, 'element_id')
      const rotation = requireNumber(args, 'degrees')
      const result = await applyPlan(env.store, env.mintId, `rotate element ${elementId} to ${rotation}°`, [
        { type: 'set_attrs', pageId, elementId, attrs: { rotation } },
      ])
      return result
    },
  },

  {
    name: 'reorder_element',
    description:
      'Change an element\'s z-order within its owner (page root or parent group). toIndex is 0-based within the owner\'s element list: 0 = bottom, length-1 = top.',
    inputSchema: objectSchema(
      {
        page_id: pageIdProp,
        element_id: elementIdProp,
        to_index: { type: 'number', description: '0-based target z-index within the element\'s owner.' },
      },
      ['page_id', 'element_id', 'to_index'],
    ),
    async run(args, env) {
      const pageId = requireString(args, 'page_id')
      const elementId = requireString(args, 'element_id')
      const toIndex = optionalNonNegativeInteger(args, 'to_index') ?? 0
      const result = await applyPlan(env.store, env.mintId, `reorder element ${elementId} to index ${toIndex}`, [
        { type: 'reorder_element', pageId, elementId, toIndex },
      ])
      return result
    },
  },

  {
    name: 'delete_element',
    description: 'Permanently delete an element (and all its children if it is a group) from a page.',
    inputSchema: objectSchema(
      { page_id: pageIdProp, element_id: elementIdProp },
      ['page_id', 'element_id'],
    ),
    async run(args, env) {
      const pageId = requireString(args, 'page_id')
      const elementId = requireString(args, 'element_id')
      const result = await applyPlan(env.store, env.mintId, `delete element ${elementId}`, [
        { type: 'delete_element', pageId, elementId },
      ])
      return result
    },
  },

  {
    name: 'group_elements',
    description:
      'Group 2+ sibling elements into a new group. Elements must share the same owner (page root or the same parent group). The group\'s origin is set to the minimum bounding box of the members; children are rebased to group-local coordinates.',
    inputSchema: objectSchema(
      {
        page_id: pageIdProp,
        element_ids: { type: 'array', items: { type: 'string' }, minItems: 2, description: '≥2 sibling element ids to group.' },
        name: { type: 'string', description: 'Layer name for the new group. Default "Group".' },
      },
      ['page_id', 'element_ids'],
    ),
    async run(args, env) {
      const pageId = requireString(args, 'page_id')
      const elementIds = requireStringArray(args, 'element_ids')
      const groupId = env.mintId()
      const result = await applyPlan(env.store, env.mintId, `group ${elementIds.length} elements`, [
        { type: 'group_elements', pageId, elementIds, groupId, name: optionalString(args, 'name') },
      ])
      return { group_id: groupId, ...result }
    },
  },

  {
    name: 'ungroup_element',
    description: 'Dissolve a group, promoting its children to the group\'s parent owner at page coordinates. The group element is removed.',
    inputSchema: objectSchema(
      { page_id: pageIdProp, group_id: { type: 'string', description: 'Id of the group element to ungroup.' } },
      ['page_id', 'group_id'],
    ),
    async run(args, env) {
      const pageId = requireString(args, 'page_id')
      const groupId = requireString(args, 'group_id')
      const result = await applyPlan(env.store, env.mintId, `ungroup ${groupId}`, [
        { type: 'ungroup_element', pageId, groupId },
      ])
      return result
    },
  },

  // ─── page management ──────────────────────────────────────────────────────

  {
    name: 'add_page',
    description: 'Add a new blank page to the document. Returns the new page\'s id.',
    inputSchema: objectSchema(
      {
        name: { type: 'string', description: 'Page name.' },
        width: { type: 'number', description: 'Width in px. Default 1080.' },
        height: { type: 'number', description: 'Height in px. Default 1080.' },
        background: colorProp('Page background. Default "#ffffff".'),
        index: { type: 'number', description: 'Position in the page list (0-based). Omit to append.' },
      },
      [],
    ),
    async run(args, env) {
      const pageId = env.mintId()
      const result = await applyPlan(env.store, env.mintId, 'add page', [
        {
          type: 'add_page',
          pageId,
          options: {
            name: optionalString(args, 'name'),
            width: optionalNumber(args, 'width'),
            height: optionalNumber(args, 'height'),
            background: optionalString(args, 'background'),
          },
          index: optionalNonNegativeInteger(args, 'index'),
        },
      ])
      return { page_id: pageId, ...result }
    },
  },

  {
    name: 'duplicate_page',
    description:
      'Duplicate an existing page including all its elements. Element ids are re-minted server-side to avoid conflicts. Returns the new page\'s id.',
    inputSchema: objectSchema(
      {
        source_page_id: { type: 'string', description: 'Page id to copy.' },
      },
      ['source_page_id'],
    ),
    async run(args, env) {
      const sourcePageId = requireString(args, 'source_page_id')
      const pageId = env.mintId()
      const result = await applyPlan(env.store, env.mintId, `duplicate page ${sourcePageId}`, [
        { type: 'duplicate_page', sourcePageId, pageId },
      ])
      return { page_id: pageId, ...result }
    },
  },

  {
    name: 'delete_page',
    description: 'Delete a page. Fails if the document has only one page.',
    inputSchema: objectSchema(
      { page_id: { type: 'string', description: 'Page id to delete.' } },
      ['page_id'],
    ),
    async run(args, env) {
      const pageId = requireString(args, 'page_id')
      const result = await applyPlan(env.store, env.mintId, `delete page ${pageId}`, [
        { type: 'delete_page', pageId },
      ])
      return result
    },
  },

  {
    name: 'set_page_props',
    description: 'Update a page\'s name, dimensions, background color, or bleed. Pass null for bleed to clear it. Omit fields you don\'t want to change.',
    inputSchema: objectSchema(
      {
        page_id: { type: 'string', description: 'Page id to update.' },
        name: { type: 'string', description: 'New page name.' },
        width: { type: 'number', description: 'New width in px.' },
        height: { type: 'number', description: 'New height in px.' },
        background: colorProp('New background color.'),
        bleed: {
          type: 'object',
          description: 'Bleed extents in px drawn OUTSIDE the page trim edge. Pass null to clear bleed.',
          properties: {
            top: { type: 'number' },
            right: { type: 'number' },
            bottom: { type: 'number' },
            left: { type: 'number' },
          },
          required: ['top', 'right', 'bottom', 'left'],
          nullable: true,
        },
      },
      ['page_id'],
    ),
    async run(args, env) {
      const pageId = requireString(args, 'page_id')
      let bleed: { top: number; right: number; bottom: number; left: number } | null | undefined
      if ('bleed' in args) {
        if (args['bleed'] === null) {
          bleed = null
        } else if (isRecord(args['bleed'])) {
          const b = args['bleed']
          bleed = {
            top: requireNumber(b, 'top'),
            right: requireNumber(b, 'right'),
            bottom: requireNumber(b, 'bottom'),
            left: requireNumber(b, 'left'),
          }
        } else {
          throw new Error('bleed must be an object with top/right/bottom/left or null to clear')
        }
      }
      const result = await applyPlan(env.store, env.mintId, `set props on page ${pageId}`, [
        {
          type: 'set_page_props',
          pageId,
          name: optionalString(args, 'name'),
          width: optionalNumber(args, 'width'),
          height: optionalNumber(args, 'height'),
          background: optionalString(args, 'background'),
          ...(bleed !== undefined ? { bleed } : {}),
        },
      ])
      return result
    },
  },

  {
    name: 'set_page_guides',
    description: 'Set ruler guides on a page. Replaces ALL existing guides for that axis — pass the full updated arrays.',
    inputSchema: objectSchema(
      {
        page_id: { type: 'string', description: 'Page id to update.' },
        vertical: { type: 'array', items: { type: 'number' }, description: 'Vertical guide positions in page-coordinate px.' },
        horizontal: { type: 'array', items: { type: 'number' }, description: 'Horizontal guide positions in page-coordinate px.' },
      },
      ['page_id', 'vertical', 'horizontal'],
    ),
    async run(args, env) {
      const pageId = requireString(args, 'page_id')
      if (!Array.isArray(args['vertical'])) throw new Error('vertical must be an array of numbers')
      if (!Array.isArray(args['horizontal'])) throw new Error('horizontal must be an array of numbers')
      const vertical = args['vertical'] as number[]
      const horizontal = args['horizontal'] as number[]
      const result = await applyPlan(env.store, env.mintId, `set guides on page ${pageId}`, [
        { type: 'set_page_guides', pageId, guides: { vertical, horizontal } },
      ])
      return result
    },
  },

  // ─── template / data binding ──────────────────────────────────────────────

  {
    name: 'bind_slot',
    description:
      'Bind or unbind a template slot name to an element. Slot names are unique document-wide. Text elements accept string data; image/video elements accept src URLs. Pass null for slot to unbind.',
    inputSchema: objectSchema(
      {
        page_id: pageIdProp,
        element_id: elementIdProp,
        slot: { type: ['string', 'null'], description: 'Slot name to bind, or null to unbind.' },
      },
      ['page_id', 'element_id', 'slot'],
    ),
    async run(args, env) {
      const pageId = requireString(args, 'page_id')
      const elementId = requireString(args, 'element_id')
      const slot = args['slot'] === null ? null : requireString(args, 'slot')
      const result = await applyPlan(env.store, env.mintId, `bind slot "${slot}" to ${elementId}`, [
        { type: 'bind_slot', pageId, elementId, slot },
      ])
      return result
    },
  },

  {
    name: 'apply_data',
    description:
      'Fill template slots with data. bindings is a {slot_name: value} map. Text slots accept any string; image/video slots accept http(s) URLs or /api/ paths; unknown slot names throw. Partial application is allowed.',
    inputSchema: objectSchema(
      {
        bindings: {
          type: 'object',
          description: 'Map of slot name → value. Text slots: string. Image/video slots: URL.',
          additionalProperties: { type: 'string' },
        },
      },
      ['bindings'],
    ),
    async run(args, env) {
      if (!isRecord(args['bindings'])) throw new Error('bindings must be an object')
      const bindings = args['bindings'] as Record<string, string>
      const result = await applyPlan(env.store, env.mintId, `apply data to ${Object.keys(bindings).length} slots`, [
        { type: 'apply_data', bindings },
      ])
      return result
    },
  },

  {
    name: 'instantiate_template',
    description:
      'Clone this document\'s page(s) with freshly minted element ids and fill the declared slots with the provided data bindings in one atomic call. Use this to produce personalized copies of a template document without modifying the original. Returns the new page ids in order. Note: this mutates the SAME document by appending copies of the requested pages with re-minted ids and applying data — it does NOT create a separate document. After calling, the document contains both the original pages and the new copies.',
    inputSchema: objectSchema(
      {
        source_page_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Page ids to clone. Omit to clone all pages.',
        },
        bindings: {
          type: 'object',
          description: 'Slot name → value map applied after cloning.',
          additionalProperties: { type: 'string' },
        },
      },
      [],
    ),
    async run(args, env) {
      const { document } = await env.store.getDocument()
      const rawSourceIds = Array.isArray(args['source_page_ids'])
        ? (args['source_page_ids'] as string[])
        : document.pages.map((p) => p.id)
      const bindings = optionalRecord(args, 'bindings') ?? {}
      if (rawSourceIds.length === 0) throw new Error('source_page_ids must not be empty')

      // Phase 1: for each source page, collect any slots to temporarily unbind
      // from the source before duplicating. apply_data's collectSlots() walks ALL
      // pages, so it throws on duplicate slot names when source and copy share the
      // same slot attribute. The strategy: unbind source slots → duplicate →
      // apply_data (only copy pages carry slots now) → re-bind source slots. All
      // four phases are one atomic applyPlan call.
      const unbindOps: SceneOperation[] = []
      const rebindOps: SceneOperation[] = []
      const dupOps: SceneOperation[] = []
      const newPageIds: string[] = []

      for (const sourcePageId of rawSourceIds) {
        const sourcePage = requirePage(document, sourcePageId)
        // Collect slots on the source page (single-page walk, no collision check).
        const sourceSlots = collectPageSlotAttrs(sourcePage)
        for (const [slotName, { elementId }] of sourceSlots) {
          unbindOps.push({ type: 'bind_slot', pageId: sourcePageId, elementId, slot: null })
          rebindOps.push({ type: 'bind_slot', pageId: sourcePageId, elementId, slot: slotName })
        }
        const pageId = env.mintId()
        newPageIds.push(pageId)
        dupOps.push({ type: 'duplicate_page', sourcePageId, pageId })
      }

      const applyDataOps: SceneOperation[] = Object.keys(bindings).length > 0
        ? [{ type: 'apply_data', bindings }]
        : []

      // Op ordering is critical: duplicate FIRST (copies inherit source slots),
      // then unbind source slots (sources now have no slots, copies still do),
      // then apply_data (only copy pages carry slots — no duplicate names),
      // then re-bind source slots (restore original state of source pages).
      const allOps: SceneOperation[] = [
        ...dupOps,
        ...unbindOps,
        ...applyDataOps,
        ...rebindOps,
      ]

      const result = await applyPlan(
        env.store,
        env.mintId,
        `instantiate template (${rawSourceIds.length} pages)`,
        allOps,
      )
      return { new_page_ids: newPageIds, ...result }
    },
  },

  // ─── lint ─────────────────────────────────────────────────────────────────

  {
    name: 'design_lint',
    description:
      'Audit the scene document for visual defects. Returns structured findings grouped by rule ' +
      'and a 0–100 quality score per page. ' +
      'HARD CONTRACT: You may not end your turn while any ERROR finding exists. After every edit or ' +
      'revision, call design_lint and resolve every ERROR before yielding. ' +
      'WORKFLOW: run design_lint after composing a page, fix every ERROR finding (text-overlap, ' +
      'element-overflow, text-overflow-band, contrast), then fix WARNING findings (hierarchy, alignment, ' +
      'spacing, palette), then rerun design_lint until errorCount is 0. ' +
      'create_export will be blocked until errorCount reaches 0 — fixing errors is not optional. ' +
      'Findings include concrete element names, measured values, and a fix suggestion — act on them directly.',
    inputSchema: objectSchema(
      { page_id: { type: 'string', description: 'Lint a single page by id. Omit to lint all pages.' } },
      [],
    ),
    async run(args, env) {
      const { document } = await env.store.getDocument()
      const pageId = optionalString(args, 'page_id')
      const report = pageId ? lintScenePage(document, pageId) : lintSceneDocument(document)
      return {
        documentScore: report.documentScore,
        errorCount: report.errorCount,
        warningCount: report.warningCount,
        pages: report.pages.map((p) => ({
          pageId: p.pageId,
          pageName: p.pageName,
          score: p.score,
          findings: p.findings.map((f) => ({
            rule: f.rule,
            severity: f.severity,
            elementIds: f.elementIds,
            message: f.message,
          })),
        })),
      }
    },
  },

  // ─── exports ──────────────────────────────────────────────────────────────

  {
    name: 'create_export',
    description:
      'Queue a document export. For "png" and "jpeg", a render job is queued and status starts as "queued" — the host renders the Konva canvas and uploads the result. For "json", the export completes immediately with the full document JSON in metadata. Returns the export record id and initial status.',
    inputSchema: objectSchema(
      {
        format: { type: 'string', enum: ['png', 'jpeg', 'json'], description: 'Export format.' },
        page_id: { type: 'string', description: 'Page to export. Omit to export all pages (first page for images).' },
        pixel_ratio: { type: 'number', description: 'Device pixel ratio for raster exports. Default 1.' },
      },
      ['format'],
    ),
    async run(args, env) {
      const format = requireEnum(args, 'format', ['png', 'jpeg', 'json'] as const)
      const pageId = optionalString(args, 'page_id')
      const pixelRatio = optionalNumber(args, 'pixel_ratio') ?? 1

      // Hard lint gate: export is blocked until all ERROR findings are resolved.
      // This enforces the design_lint contract structurally rather than as a
      // prompt suggestion the model can skip.
      const { document: lintDoc } = await env.store.getDocument()
      const lintReport = pageId ? lintScenePage(lintDoc, pageId) : lintSceneDocument(lintDoc)
      if (lintReport.errorCount > 0) {
        const errorMessages = lintReport.pages
          .flatMap((p) => p.findings.filter((f) => f.severity === 'error'))
          .map((f) => f.message)
          .join(' | ')
        throw new Error(
          `Export blocked: ${lintReport.errorCount} lint error(s) must be fixed before export. ` +
          `Run design_lint, resolve every ERROR finding, then retry create_export. ` +
          `Errors: ${errorMessages}`,
        )
      }

      let metadata: Record<string, unknown> = {
        pageId: pageId ?? null,
        pixelRatio,
      }

      if (format === 'json') {
        const { document, rev } = await env.store.getDocument()
        metadata = { ...metadata, document, rev }
      }

      const exportRecord = await env.store.createExport(format, metadata)
      await env.store.recordDecision({
        kind: 'export',
        instruction: `create ${format} export${pageId ? ` for page ${pageId}` : ''}`,
        metadata: { tool: 'create_export', export_id: exportRecord.id, format },
      })
      return {
        export_id: exportRecord.id,
        format: exportRecord.format,
        status: exportRecord.status,
        metadata: exportRecord.metadata,
        created_at: exportRecord.createdAt,
      }
    },
  },

  // ─── themes + archetypes ─────────────────────────────────────────────────

  {
    name: 'list_themes',
    description:
      'List all available ThemePack design languages. Returns id, name, mood, and a palette summary for each. ' +
      'WORKFLOW: call list_themes first to pick a visual direction, then call scaffold_from_archetype — ' +
      'never compose from a blank page when an archetype fits the target format.',
    inputSchema: objectSchema({}, []),
    async run(_args, _env) {
      return {
        themes: THEME_PACKS.map((t) => ({
          id: t.id,
          name: t.name,
          mood: t.mood,
          palette: {
            background: t.palette.background,
            surface: t.palette.surface,
            textPrimary: t.palette.textPrimary,
            textSecondary: t.palette.textSecondary,
            accent: t.palette.accent,
            accentText: t.palette.accentText,
          },
          displayFamily: t.typography.display.family,
          bodyFamily: t.typography.body.family,
          doctrine: t.doctrine,
        })),
      }
    },
  },

  {
    name: 'list_archetypes',
    description:
      'List all available layout archetypes. Returns id, label, description, and the full slot list for each. ' +
      'Use this to identify which archetype fits the desired output format before calling scaffold_from_archetype. ' +
      'Scaffold first, adapt second — archetypes produce a correct, grid-aligned skeleton so you never start from a blank page.',
    inputSchema: objectSchema({}, []),
    async run(_args, _env) {
      return {
        archetypes: ARCHETYPE_DESCRIPTORS.map((a) => ({
          id: a.id,
          label: a.label,
          description: a.description,
          slots: a.slots,
          defaultWidth: a.defaultWidth,
          defaultHeight: a.defaultHeight,
        })),
      }
    },
  },

  {
    name: 'scaffold_from_archetype',
    description:
      'Build a fully-composed scene document from an archetype + theme combination and REPLACE the current ' +
      'document\'s pages with the archetype output. Optionally fill slot bindings in the same call. ' +
      'WORKFLOW: scaffold_from_archetype is the canonical starting point for any new asset — it produces a ' +
      'grid-aligned skeleton with correct hierarchy and real placeholder copy. Adapt slots with apply_data, ' +
      'then refine individual elements. Call design_lint after adapting to catch any issues before export. ' +
      'Returns the new document state including page ids and slot summary.',
    inputSchema: objectSchema(
      {
        archetype_id: {
          type: 'string',
          description: 'Archetype id — call list_archetypes to discover valid values.',
        },
        theme_id: {
          type: 'string',
          description: 'ThemePack id — call list_themes to discover valid values.',
        },
        preset_id: {
          type: 'string',
          description: 'Export preset id to derive frame dimensions from (optional). When omitted the archetype default size is used.',
        },
        bindings: {
          type: 'object',
          description: 'Slot name → value map applied immediately after scaffolding. Partial application is allowed.',
          additionalProperties: { type: 'string' },
        },
      },
      ['archetype_id', 'theme_id'],
    ),
    async run(args, env) {
      const archetypeId = requireString(args, 'archetype_id')
      const themeId = requireString(args, 'theme_id')
      const presetId = optionalString(args, 'preset_id')
      const bindings = optionalRecord(args, 'bindings') ?? {}

      // Validate theme exists before building (requireThemePack throws loud)
      requireThemePack(themeId)

      // Build archetype document — throws on unknown archetype or theme
      const archetypeDoc = buildArchetype(archetypeId, themeId, presetId)

      // Apply slot bindings if provided
      let finalDoc = archetypeDoc
      if (Object.keys(bindings).length > 0) {
        const { applyBindingsToDocument } = await import('./templates')
        finalDoc = applyBindingsToDocument(archetypeDoc, bindings)
      }

      // Get the current document revision so we can overwrite it
      const { rev } = await env.store.getDocument()

      // Overwrite the document with the scaffolded content
      const saved = await env.store.saveDocument(finalDoc, rev)

      await env.store.recordDecision({
        kind: 'agent_edit',
        instruction: `scaffold_from_archetype: archetype=${archetypeId} theme=${themeId}${presetId ? ` preset=${presetId}` : ''}${Object.keys(bindings).length > 0 ? ` bindings=[${Object.keys(bindings).join(', ')}]` : ''}`,
        metadata: { tool: 'scaffold_from_archetype', archetypeId, themeId, presetId: presetId ?? null },
      })

      // Build slot summary from saved document
      const { collectSlots } = await import('./model')
      const slots = collectSlots(saved.document)
      const slotSummary: Array<{ name: string; pageId: string; kind: string }> = []
      for (const [name, { pageId, kind }] of slots) {
        slotSummary.push({ name, pageId, kind })
      }

      return {
        rev: saved.rev,
        title: saved.document.title,
        page_count: saved.document.pages.length,
        pages: saved.document.pages.map((p) => ({
          id: p.id,
          name: p.name,
          width: p.width,
          height: p.height,
        })),
        slots: slotSummary,
        archetype_id: archetypeId,
        theme_id: themeId,
      }
    },
  },
]

export { CANVAS_MCP_TOOLS }

export function findCanvasMcpTool(
  name: string,
): McpToolDefinition<DesignCanvasMcpToolEnv> | undefined {
  return CANVAS_MCP_TOOLS.find((tool) => tool.name === name)
}

export const CANVAS_MCP_TOOL_NAMES = CANVAS_MCP_TOOLS.map((t) => t.name)
export const CANVAS_ELEMENT_KINDS: readonly string[] = SCENE_ELEMENT_KINDS
