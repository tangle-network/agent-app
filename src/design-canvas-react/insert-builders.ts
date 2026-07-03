/**
 * Pure builders for the human "add element to the canvas" path — the math and
 * `SceneOperation` construction behind {@link CanvasInsertPanel}, separated from
 * the React/DOM layer so every insert is unit-testable without Konva or a
 * browser. The panel calls these to produce `add_element` operations and hands
 * them to the host's `onApplyOperations` (server-validated, undoable) — the same
 * pipeline every other edit flows through.
 *
 * Media boundary: image inserts must pass {@link assertSceneMediaSrc} (remote
 * http(s) or a rooted `/api/` path — never `data:` blobs or sandbox-local
 * files). Builders that take a src assert it up front so a bad url fails here,
 * not deep in the apply layer.
 */

import { assertSceneMediaSrc } from '../design-canvas/model'
import type {
  EllipseElement,
  ImageElement,
  RectElement,
  SceneElement,
  TextElement,
} from '../design-canvas/model'
import type { SceneOperation } from '../design-canvas/operations'

/** Largest dimension (document px) a freshly inserted element is fitted to,
 *  before the page-size cap applies. Keeps a huge upload from filling the page. */
export const MAX_INSERT_DIMENSION = 600

/** Active page geometry an insert lands into — drives centering and fitting. */
export interface InsertPageGeometry {
  pageId: string
  width: number
  height: number
  background?: string
}

/** Mint a DOM-safe element id. Prefers `crypto.randomUUID`; falls back to a
 *  time+random id where crypto is unavailable (older runtimes, some test envs). */
export function mintElementId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `el-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Fit (naturalW, naturalH) under a max-dimension cap (further bounded by the
 *  page), preserving aspect ratio. Never upscales past natural size. */
export function fittedSize(
  naturalW: number,
  naturalH: number,
  pageWidth: number,
  pageHeight: number,
): { width: number; height: number } {
  const cap = Math.min(MAX_INSERT_DIMENSION, pageWidth * 0.8, pageHeight * 0.8)
  const longest = Math.max(naturalW, naturalH)
  const scale = naturalW > 0 && naturalH > 0 ? Math.min(1, cap / longest) : 1
  const width = Math.max(1, Math.round((naturalW || cap) * scale))
  const height = Math.max(1, Math.round((naturalH || cap) * scale))
  return { width, height }
}

/** Top-left position that centers a (width, height) box on the page. */
export function centeredPosition(
  width: number,
  height: number,
  pageWidth: number,
  pageHeight: number,
): { x: number; y: number } {
  return {
    x: Math.round((pageWidth - width) / 2),
    y: Math.round((pageHeight - height) / 2),
  }
}

/** Common element fields with a freshly minted id and unrotated/visible defaults. */
function baseAttrs(name: string, x: number, y: number) {
  return { id: mintElementId(), name, x, y, rotation: 0, opacity: 1, locked: false, visible: true }
}

/** Wrap a single element in an `add_element` op for the active page. */
function addElementOp(pageId: string, element: SceneElement): SceneOperation {
  return { type: 'add_element', pageId, element }
}

function hexLuminance(color: string | undefined): number | null {
  if (!color) return null
  const raw = color.trim()
  const hex = raw.startsWith('#') ? raw.slice(1) : ''
  const full = hex.length === 3
    ? hex.split('').map((ch) => ch + ch).join('')
    : hex.length === 6
      ? hex
      : ''
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null
  const channels = [0, 2, 4].map((start) => parseInt(full.slice(start, start + 2), 16) / 255)
  const [r, g, b] = channels.map((value) => (
    value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
  ))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function pageTextFill(page: InsertPageGeometry, tone: 'primary' | 'secondary'): string {
  const luminance = hexLuminance(page.background)
  if (luminance !== null && luminance < 0.35) {
    return tone === 'primary' ? '#f8fafc' : '#cbd5e1'
  }
  return tone === 'primary' ? '#111827' : '#374151'
}

/**
 * Build an `add_element` op placing an image, fitted and centered on the page.
 * `naturalSize` is the probed image dimensions (the panel reads them in the
 * browser); pass `{ width: 0, height: 0 }` when unknown to fall back to the cap.
 *
 * Throws (via `assertSceneMediaSrc`) when `src` is not http(s) or a rooted
 * `/api/` path — callers should surface the error, never insert a `data:` src.
 */
export function buildInsertImageOp(
  src: string,
  naturalSize: { width: number; height: number },
  page: InsertPageGeometry,
): SceneOperation {
  assertSceneMediaSrc(src, 'image src')
  const { width, height } = fittedSize(naturalSize.width, naturalSize.height, page.width, page.height)
  const { x, y } = centeredPosition(width, height, page.width, page.height)
  const element: ImageElement = {
    ...baseAttrs('Image', x, y),
    kind: 'image',
    width,
    height,
    src,
    fit: 'contain',
  }
  return addElementOp(page.pageId, element)
}

/** A template the insert panel can drop without the agent. `build` is pure and
 *  produces the operations for the active page geometry. */
export interface InsertTemplate {
  id: string
  label: string
  build(page: InsertPageGeometry): SceneOperation[]
}

/** The built-in starter templates (heading, body text, rectangle, ellipse).
 *  Consumers can pass their own list to {@link CanvasInsertPanel}; this is the
 *  default so every canvas gets a usable set out of the box. */
export const DEFAULT_INSERT_TEMPLATES: readonly InsertTemplate[] = [
  {
    id: 'heading',
    label: 'Heading',
    build(page) {
      const width = Math.min(480, Math.round(page.width * 0.7))
      const { x, y } = centeredPosition(width, 60, page.width, page.height)
      const element: TextElement = {
        ...baseAttrs('Heading', x, y),
        kind: 'text',
        text: 'Add a headline',
        width,
        fontFamily: 'Inter',
        fontSize: 48,
        fontStyle: 'bold',
        fill: pageTextFill(page, 'primary'),
        align: 'left',
        lineHeight: 1.1,
        letterSpacing: 0,
      }
      return [addElementOp(page.pageId, element)]
    },
  },
  {
    id: 'body',
    label: 'Body text',
    build(page) {
      const width = Math.min(420, Math.round(page.width * 0.6))
      const { x, y } = centeredPosition(width, 80, page.width, page.height)
      const element: TextElement = {
        ...baseAttrs('Body', x, y),
        kind: 'text',
        text: 'Add a paragraph of supporting copy.',
        width,
        fontFamily: 'Inter',
        fontSize: 20,
        fontStyle: 'normal',
        fill: pageTextFill(page, 'secondary'),
        align: 'left',
        lineHeight: 1.4,
        letterSpacing: 0,
      }
      return [addElementOp(page.pageId, element)]
    },
  },
  {
    id: 'rect',
    label: 'Rectangle',
    build(page) {
      const width = Math.min(320, Math.round(page.width * 0.4))
      const height = Math.min(200, Math.round(page.height * 0.3))
      const { x, y } = centeredPosition(width, height, page.width, page.height)
      const element: RectElement = {
        ...baseAttrs('Rectangle', x, y),
        kind: 'rect',
        width,
        height,
        fill: '#6366f1',
        cornerRadius: 12,
      }
      return [addElementOp(page.pageId, element)]
    },
  },
  {
    id: 'ellipse',
    label: 'Ellipse',
    build(page) {
      const size = Math.min(220, Math.round(Math.min(page.width, page.height) * 0.3))
      const { x, y } = centeredPosition(size, size, page.width, page.height)
      const element: EllipseElement = {
        ...baseAttrs('Ellipse', x, y),
        kind: 'ellipse',
        width: size,
        height: size,
        fill: '#10b981',
      }
      return [addElementOp(page.pageId, element)]
    },
  },
]
