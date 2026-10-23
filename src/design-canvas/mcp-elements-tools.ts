import type { McpToolDefinition } from '../tools/mcp-rpc'
import { type DesignCanvasMcpToolEnv, resolvePageId, applyPlan } from './mcp-context'
import { objectSchema, requireMcpString, requireEnum, isRecord } from '../tools/mcp-arguments'
import {
  pageIdProp,
  xProp,
  yProp,
  widthProp,
  colorProp,
  optionalString,
  requireNumber,
  optionalNumber,
  optionalEnum,
  heightProp,
  elementIdProp,
  optionalNonNegativeInteger,
  requireStringArray,
} from './mcp-input'
import type {
  TextElement,
  ImageElement,
  SceneElement,
  RectElement,
  EllipseElement,
  LineElement,
  VideoElement,
} from './model'

export const CANVAS_ELEMENTS_TOOLS: McpToolDefinition<DesignCanvasMcpToolEnv>[] = [
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
      const text = requireMcpString(args, 'text')
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
        src: requireMcpString(args, 'src'),
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
        src: requireMcpString(args, 'src'),
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
      const pageId = requireMcpString(args, 'page_id')
      const elementId = requireMcpString(args, 'element_id')
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
      const pageId = requireMcpString(args, 'page_id')
      const elementId = requireMcpString(args, 'element_id')
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
      const pageId = requireMcpString(args, 'page_id')
      const elementId = requireMcpString(args, 'element_id')
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
      const pageId = requireMcpString(args, 'page_id')
      const elementId = requireMcpString(args, 'element_id')
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
      const pageId = requireMcpString(args, 'page_id')
      const elementId = requireMcpString(args, 'element_id')
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
      const pageId = requireMcpString(args, 'page_id')
      const elementId = requireMcpString(args, 'element_id')
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
      const pageId = requireMcpString(args, 'page_id')
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
      const pageId = requireMcpString(args, 'page_id')
      const groupId = requireMcpString(args, 'group_id')
      const result = await applyPlan(env.store, env.mintId, `ungroup ${groupId}`, [
        { type: 'ungroup_element', pageId, groupId },
      ])
      return result
    },
  }
]
