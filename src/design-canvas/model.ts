/**
 * Design-canvas scene model — the product-agnostic document behind the visual
 * asset editor. A document is an ordered list of pages; a page is an ordered
 * list of elements (index order IS z-order, bottom→top); every element is a
 * typed node with a closed attribute vocabulary. The whole document
 * serializes as one JSON value and persists atomically with a revision
 * counter (see ./store) — every canvas action is a durable operation against
 * this schema, which is what makes the canvas automatable: agents and
 * external data sources mutate the same document the editor renders.
 *
 * Units are CSS pixels throughout; `settings.dpi` carries the print
 * conversion factor for bleed/trim-aware exports. Angles are degrees.
 * Nothing here touches Konva, React, or a database.
 */

export const SCENE_SCHEMA_VERSION = 1

export interface SceneDocument {
  schemaVersion: typeof SCENE_SCHEMA_VERSION
  title: string
  pages: ScenePage[]
  settings: SceneSettings
  metadata: Record<string, unknown>
}

export interface SceneSettings {
  /** Print conversion factor for mm↔px math at export; 96 = CSS default. */
  dpi: number
}

/** Per-side bleed extents in px, drawn OUTSIDE the page bounds. Trim = the
 *  page rect itself; exports may include or exclude the bleed area. */
export interface PageBleed {
  top: number
  right: number
  bottom: number
  left: number
}

/** Saved ruler guides, in page coordinates. */
export interface PageGuides {
  vertical: number[]
  horizontal: number[]
}

export interface ScenePage {
  id: string
  name: string
  width: number
  height: number
  /** Page background fill (color string); elements paint over it. */
  background: string
  bleed: PageBleed | null
  guides: PageGuides
  elements: SceneElement[]
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

/** Attributes every element carries. `x`/`y` are the element's top-left in
 *  page coordinates (for `group`, children are relative to the group origin).
 *  `slot` names a template binding point — `apply_data` targets it. */
export interface SceneElementBase {
  id: string
  name: string
  x: number
  y: number
  /** Degrees, clockwise, about the element's top-left origin (Konva default). */
  rotation: number
  /** 0..1 */
  opacity: number
  locked: boolean
  visible: boolean
  slot?: string
}

export interface RectElement extends SceneElementBase {
  kind: 'rect'
  width: number
  height: number
  fill: string
  stroke?: string
  strokeWidth?: number
  cornerRadius?: number
}

export interface EllipseElement extends SceneElementBase {
  kind: 'ellipse'
  width: number
  height: number
  fill: string
  stroke?: string
  strokeWidth?: number
}

export interface LineElement extends SceneElementBase {
  kind: 'line'
  /** Flat [x0, y0, x1, y1, ...] relative to (x, y); ≥ 2 points. */
  points: number[]
  stroke: string
  strokeWidth: number
  dash?: number[]
}

export interface TextElement extends SceneElementBase {
  kind: 'text'
  text: string
  /** Wrap width; height derives from content. */
  width: number
  fontFamily: string
  fontSize: number
  fontStyle: 'normal' | 'bold' | 'italic' | 'bold italic'
  fill: string
  align: 'left' | 'center' | 'right'
  lineHeight: number
  letterSpacing: number
}

export interface ImageElement extends SceneElementBase {
  kind: 'image'
  width: number
  height: number
  /** http(s) or rooted /api/ path — same boundary rule as sequences media. */
  src: string
  /** How the source maps into the frame; 'fill' stretches, 'cover' crops. */
  fit: 'fill' | 'cover' | 'contain'
}

/** Video placed on a canvas renders and exports as its poster frame — motion
 *  belongs to the sequences surface; this keeps video assets placeable in
 *  static layouts (e.g. a thumbnail mock) without a playback engine. */
export interface VideoElement extends SceneElementBase {
  kind: 'video'
  width: number
  height: number
  src: string
  posterSrc?: string
}

export interface GroupElement extends SceneElementBase {
  kind: 'group'
  children: SceneElement[]
}

export type SceneElement =
  | RectElement
  | EllipseElement
  | LineElement
  | TextElement
  | ImageElement
  | VideoElement
  | GroupElement

export type SceneElementKind = SceneElement['kind']

export const SCENE_ELEMENT_KINDS: readonly SceneElementKind[] = [
  'rect', 'ellipse', 'line', 'text', 'image', 'video', 'group',
] as const

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** Unrotated local extent of an element (line/group derive from content). */
export function elementExtent(element: SceneElement): { width: number; height: number } {
  switch (element.kind) {
    case 'rect':
    case 'ellipse':
    case 'image':
    case 'video':
      return { width: element.width, height: element.height }
    case 'text':
      // Height derives from content at render time; the model exposes a
      // deterministic estimate so layout math (snapping, describe) never
      // depends on a canvas context: lines × fontSize × lineHeight.
      return {
        width: element.width,
        height: estimateTextHeight(element),
      }
    case 'line': {
      let maxX = 0
      let maxY = 0
      for (let i = 0; i < element.points.length; i += 2) {
        maxX = Math.max(maxX, Math.abs(element.points[i]!))
        maxY = Math.max(maxY, Math.abs(element.points[i + 1]!))
      }
      return { width: maxX, height: maxY }
    }
    case 'group': {
      // minX/minY track the negative-space corner: a rotated child whose AABB
      // extends left/above the group origin contributes negative values, so
      // minX/minY must seed from the first child, not 0 (0 clips negative AABBs).
      let minX = 0, minY = 0, maxX = 0, maxY = 0
      for (const child of element.children) {
        const aabb = elementAabb(child)
        minX = Math.min(minX, aabb.x)
        minY = Math.min(minY, aabb.y)
        maxX = Math.max(maxX, aabb.x + aabb.width)
        maxY = Math.max(maxY, aabb.y + aabb.height)
      }
      return { width: maxX - minX, height: maxY - minY }
    }
  }
}

export function estimateTextHeight(element: Pick<TextElement, 'text' | 'fontSize' | 'lineHeight'>): number {
  const lines = element.text.length === 0 ? 1 : element.text.split('\n').length
  return lines * element.fontSize * element.lineHeight
}

/** Axis-aligned bounding box in the parent's coordinate space, accounting for
 *  rotation about the element's top-left origin. */
export function elementAabb(element: SceneElement): Bounds {
  const { width, height } = elementExtent(element)
  if (element.rotation % 360 === 0) {
    return { x: element.x, y: element.y, width, height }
  }
  const rad = (element.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const corners: Array<[number, number]> = [
    [0, 0],
    [width * cos, width * sin],
    [-height * sin, height * cos],
    [width * cos - height * sin, width * sin + height * cos],
  ]
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [cx, cy] of corners) {
    minX = Math.min(minX, cx); minY = Math.min(minY, cy)
    maxX = Math.max(maxX, cx); maxY = Math.max(maxY, cy)
  }
  return { x: element.x + minX, y: element.y + minY, width: maxX - minX, height: maxY - minY }
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

// ---------------------------------------------------------------------------
// Lookup + traversal
// ---------------------------------------------------------------------------

export function requirePage(document: SceneDocument, pageId: string): ScenePage {
  const page = document.pages.find((candidate) => candidate.id === pageId)
  if (!page) throw new Error(`page ${pageId} not found in document`)
  return page
}

/** Depth-first search across a page including group children. Returns the
 *  element and the array that owns it (page.elements or a group's children),
 *  so callers can splice in place. */
export function findElement(page: ScenePage, elementId: string): { element: SceneElement; owner: SceneElement[]; index: number } | null {
  const stack: SceneElement[][] = [page.elements]
  while (stack.length > 0) {
    const owner = stack.pop()!
    for (let index = 0; index < owner.length; index += 1) {
      const element = owner[index]!
      if (element.id === elementId) return { element, owner, index }
      if (element.kind === 'group') stack.push(element.children)
    }
  }
  return null
}

export function requireElement(page: ScenePage, elementId: string): { element: SceneElement; owner: SceneElement[]; index: number } {
  const found = findElement(page, elementId)
  if (!found) throw new Error(`element ${elementId} not found on page ${page.id}`)
  return found
}

/** All slot names declared across the document — the template's fillable
 *  surface. Duplicate slot names are a validation error (see ./validate). */
export function collectSlots(document: SceneDocument): Map<string, { pageId: string; elementId: string; kind: SceneElementKind }> {
  const slots = new Map<string, { pageId: string; elementId: string; kind: SceneElementKind }>()
  for (const page of document.pages) {
    const stack = [...page.elements]
    while (stack.length > 0) {
      const element = stack.pop()!
      if (element.slot) {
        if (slots.has(element.slot)) throw new Error(`duplicate slot name "${element.slot}"`)
        slots.set(element.slot, { pageId: page.id, elementId: element.id, kind: element.kind })
      }
      if (element.kind === 'group') stack.push(...element.children)
    }
  }
  return slots
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface NewPageOptions {
  name?: string
  width?: number
  height?: number
  background?: string
}

export function createEmptyDocument(title: string, page?: NewPageOptions): SceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    title,
    pages: [createPage(page ?? {}, 'page-1')],
    settings: { dpi: 96 },
    metadata: {},
  }
}

export function createPage(options: NewPageOptions, id: string): ScenePage {
  const width = options.width ?? 1080
  const height = options.height ?? 1080
  assertPositiveFinite(width, 'page width')
  assertPositiveFinite(height, 'page height')
  return {
    id,
    name: options.name ?? 'Page',
    width,
    height,
    background: options.background ?? '#ffffff',
    bleed: null,
    guides: { vertical: [], horizontal: [] },
    elements: [],
  }
}

export function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number`)
}

export function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
}

const COLOR_PATTERN = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)|transparent)$/

export function assertColor(value: string, label: string): void {
  if (!COLOR_PATTERN.test(value)) throw new Error(`${label} must be a hex/rgb(a) color or 'transparent', got "${value}"`)
}

/** Media boundary rule shared with sequences: remote http(s) or a rooted
 *  /api/ path — never sandbox-local files or data: blobs. */
export function assertSceneMediaSrc(value: string, label: string): void {
  if (/^https?:\/\//i.test(value) || /^\/api\//.test(value)) return
  throw new Error(`${label} must be an http(s) URL or a rooted /api/ path, got "${value}"`)
}
