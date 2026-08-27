/**
 * Per-kind Konva node rendering for SceneElement. Each element kind maps to
 * the appropriate Konva primitive; geometry is converted from the model's
 * top-left convention where needed.
 *
 * Ellipse center-offset invariant: the model stores (x, y) as the top-left
 * corner of the bounding box. Konva.Ellipse draws from its center point.
 * The conversion is: centerX = x + width/2, centerY = y + height/2,
 * radiusX = width/2, radiusY = height/2. The reverse applies when reading
 * back from transformer output (see transform-math.ts:ellipseTopLeftFromCenter).
 *
 * Image loading: src is loaded async into an HTMLImageElement via useEffect,
 * cached per src in a module-level Map so repeated renders of the same src
 * don't re-fetch. A broken-image placeholder rect is shown while loading or on
 * error; its `name` carries the src for diagnostics.
 *
 * Video elements render as their poster image when posterSrc is set, or a
 * placeholder rect. This is intentional — motion belongs to the sequences
 * surface; the canvas surface is for static layout.
 *
 * Node name: each node's `name` prop carries the element id so hit→model
 * mapping in Workspace works: `stage.getIntersection(pos)?.name()`.
 *
 * locked → listening(false) except on the click handler for selection.
 * hidden → not rendered.
 */

import { memo, useEffect, useRef, useState } from 'react'
import { Group, Rect, Ellipse, Line, Text, Image as KonvaImage } from 'react-konva'
import type Konva from 'konva'
import { ellipseCenterFromTopLeft } from './transform-math'
import { lightTheme, type CanvasRenderPalette } from '../../theme/theme'
import type {
  SceneElement,
  RectElement,
  EllipseElement,
  LineElement,
  TextElement,
  ImageElement,
  VideoElement,
  GroupElement,
} from '../../design-canvas/model'

// ---------------------------------------------------------------------------
// Image cache — module-level so it survives re-renders
// ---------------------------------------------------------------------------

// LRU bound: large asset libraries with many unique src URLs would accumulate
// held HTMLImageElement objects indefinitely without eviction. 256 entries
// covers any reasonable single-session use and keeps memory predictable.
const IMAGE_CACHE_MAX = 256

const imageCache = new Map<string, HTMLImageElement>()

/** Evict the least-recently-inserted entry when the cache is at capacity.
 *  Map iteration order is insertion order, so the first key is the oldest. */
function imageCacheSet(src: string, img: HTMLImageElement): void {
  if (imageCache.size >= IMAGE_CACHE_MAX) {
    const oldest = imageCache.keys().next().value
    if (oldest !== undefined) imageCache.delete(oldest)
  }
  imageCache.set(src, img)
}

function useImage(src: string): HTMLImageElement | null {
  const [, setVersion] = useState(0)

  useEffect(() => {
    if (imageCache.has(src)) return
    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      imageCacheSet(src, img)
      setVersion((v) => v + 1)
    }
    img.onerror = () => {
      // Store a sentinel so we don't retry infinitely; placeholder renders instead.
      imageCacheSet(src, img)
      setVersion((v) => v + 1)
    }
    img.src = src
  }, [src])

  return imageCache.get(src) ?? null
}

// ---------------------------------------------------------------------------
// Element node dispatcher
// ---------------------------------------------------------------------------

export interface ElementNodeProps {
  element: SceneElement
  isSelected: boolean
  zoom: number
  /** Theme render palette. Omitted → light defaults (byte-identical history). */
  render?: CanvasRenderPalette
  onClick?(elementId: string): void
  onDragStart?(elementId: string): void
  onDragMove?(elementId: string, dx: number, dy: number): void
  onDragEnd?(elementId: string, finalX: number, finalY: number): void
  onDoubleClick?(elementId: string): void
}

function ElementNodeImpl(props: ElementNodeProps) {
  const { element } = props
  if (!element.visible) return null

  switch (element.kind) {
    case 'rect':    return <RectNode    {...props} element={element} />
    case 'ellipse': return <EllipseNode {...props} element={element} />
    case 'line':    return <LineNode    {...props} element={element} />
    case 'text':    return <TextNode    {...props} element={element} />
    case 'image':   return <ImageNode   {...props} element={element} />
    case 'video':   return <VideoNode   {...props} element={element} />
    case 'group':   return <GroupNode   {...props} element={element} />
  }
}

/**
 * Memoized so a `stack.notify()` (fired ~120/s during a pan/marquee) that
 * re-renders WorkspaceView does NOT re-render every element. With stable
 * handler identities supplied by WorkspaceView, an ElementNode re-renders only
 * when its OWN `element` reference, `isSelected`, `zoom`, or `render` palette
 * change — i.e. when it actually moved, was (de)selected, or the view scaled.
 * Pan-only frames change none of these props, so the N nodes stay reconciled.
 */
export const ElementNode = memo(ElementNodeImpl)

// ---------------------------------------------------------------------------
// Shared drag handlers factory
// ---------------------------------------------------------------------------

interface DragBindings {
  draggable: boolean
  listening: boolean
  /** True between dragStart and dragEnd — gates Konva node caching off so the
   *  moving node redraws live instead of showing a stale cached bitmap. */
  dragging: boolean
  onDragStart?: (e: { target: { x(): number; y(): number } }) => void
  onDragMove?: (e: { target: { x(): number; y(): number } }) => void
  onDragEnd?: (e: { target: { x(): number; y(): number } }) => void
  onClick?: (e: unknown) => void
  onDblClick?: (e: unknown) => void
}

function useDragBindings(props: ElementNodeProps, originX: number, originY: number): DragBindings {
  const { element, onClick, onDragStart, onDragMove, onDragEnd, onDoubleClick } = props
  const isDraggable = !element.locked && !!onDragEnd
  const originRef = useRef({ x: originX, y: originY })
  originRef.current = { x: originX, y: originY }
  const [dragging, setDragging] = useState(false)

  return {
    draggable: isDraggable,
    // locked elements still receive click for selection; listening must be true.
    listening: true,
    dragging,
    onDragStart: isDraggable ? () => { setDragging(true); onDragStart?.(element.id) } : undefined,
    onDragMove: isDraggable ? (e: { target: { x(): number; y(): number } }) => {
      onDragMove?.(element.id, e.target.x() - originRef.current.x, e.target.y() - originRef.current.y)
    } : undefined,
    onDragEnd: isDraggable ? (e: { target: { x(): number; y(): number } }) => {
      setDragging(false)
      onDragEnd?.(element.id, e.target.x(), e.target.y())
    } : undefined,
    onClick: () => onClick?.(element.id),
    onDblClick: () => onDoubleClick?.(element.id),
  }
}

/**
 * Konva node bitmap caching for static elements. A cached node draws from a
 * pre-rasterized bitmap instead of re-running its shape draw each frame, which
 * is the snappiness win when many static nodes are on stage during a pan/zoom.
 *
 * Gated OFF while `isSelected || dragging`: a selected node is under the
 * transformer (resize/rotate must redraw live) and a dragging node moves every
 * frame — a cached bitmap would freeze its visuals. On select/drag start the
 * cache is cleared; on deselect/drop it is re-cached. `zoom` is a dependency so
 * the bitmap re-rasterizes at the current scale and never looks blurry.
 */
function useNodeCache(
  ref: React.RefObject<Konva.Node | null>,
  isSelected: boolean,
  dragging: boolean,
  zoom: number,
  invalidateKey: unknown,
): void {
  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (isSelected || dragging) {
      // clearCache is a no-op when the node was never cached.
      node.clearCache()
      return
    }
    node.cache()
    return () => {
      // Drop the bitmap when the node unmounts or before re-caching so a stale
      // bitmap is never left attached across a prop change.
      node.clearCache()
    }
    // `invalidateKey` (the element reference) re-rasterizes the bitmap when any
    // element attribute changes; `zoom` keeps it crisp at the current scale.
  }, [ref, isSelected, dragging, zoom, invalidateKey])
}

// ---------------------------------------------------------------------------
// Rect
// ---------------------------------------------------------------------------

function RectNode({ element, ...rest }: ElementNodeProps & { element: RectElement }) {
  const { dragging, ...drag } = useDragBindings({ element, ...rest }, element.x, element.y)
  const ref = useRef<Konva.Rect | null>(null)
  useNodeCache(ref, rest.isSelected, dragging, rest.zoom, element)
  return (
    <Rect
      ref={ref}
      name={element.id}
      x={element.x}
      y={element.y}
      width={element.width}
      height={element.height}
      rotation={element.rotation}
      opacity={element.opacity}
      fill={element.fill}
      stroke={element.stroke}
      strokeWidth={element.strokeWidth}
      cornerRadius={element.cornerRadius ?? 0}
      {...drag}
    />
  )
}

// ---------------------------------------------------------------------------
// Ellipse
// ---------------------------------------------------------------------------

function EllipseNode({ element, ...rest }: ElementNodeProps & { element: EllipseElement }) {
  // Model: top-left (x, y) + width/height bounding box.
  // Konva.Ellipse: center (x, y) + radiusX/radiusY.
  const { x: cx, y: cy, radiusX, radiusY } = ellipseCenterFromTopLeft(element)
  const { dragging, ...drag } = useDragBindings({ element, ...rest }, element.x, element.y)
  const ref = useRef<Konva.Ellipse | null>(null)
  useNodeCache(ref, rest.isSelected, dragging, rest.zoom, element)

  return (
    <Ellipse
      ref={ref}
      name={element.id}
      x={cx}
      y={cy}
      radiusX={radiusX}
      radiusY={radiusY}
      rotation={element.rotation}
      opacity={element.opacity}
      fill={element.fill}
      stroke={element.stroke}
      strokeWidth={element.strokeWidth}
      {...drag}
    />
  )
}

// ---------------------------------------------------------------------------
// Line
// ---------------------------------------------------------------------------

function LineNode({ element, ...rest }: ElementNodeProps & { element: LineElement }) {
  const { dragging, ...drag } = useDragBindings({ element, ...rest }, element.x, element.y)
  const ref = useRef<Konva.Line | null>(null)
  useNodeCache(ref, rest.isSelected, dragging, rest.zoom, element)
  return (
    <Line
      ref={ref}
      name={element.id}
      x={element.x}
      y={element.y}
      points={element.points}
      rotation={element.rotation}
      opacity={element.opacity}
      stroke={element.stroke}
      strokeWidth={element.strokeWidth}
      dash={element.dash}
      {...drag}
    />
  )
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const FONT_STYLE_MAP: Record<TextElement['fontStyle'], { fontStyle: string; fontVariant: string; fontWeight: string }> = {
  'normal':      { fontStyle: 'normal',  fontVariant: 'normal', fontWeight: 'normal' },
  'bold':        { fontStyle: 'normal',  fontVariant: 'normal', fontWeight: 'bold' },
  'italic':      { fontStyle: 'italic',  fontVariant: 'normal', fontWeight: 'normal' },
  'bold italic': { fontStyle: 'italic',  fontVariant: 'normal', fontWeight: 'bold' },
}

function TextNode({ element, ...rest }: ElementNodeProps & { element: TextElement }) {
  const { dragging, ...drag } = useDragBindings({ element, ...rest }, element.x, element.y)
  const ref = useRef<Konva.Text | null>(null)
  useNodeCache(ref, rest.isSelected, dragging, rest.zoom, element)
  const { fontStyle, fontWeight } = FONT_STYLE_MAP[element.fontStyle]

  return (
    <Text
      ref={ref}
      name={element.id}
      x={element.x}
      y={element.y}
      width={element.width}
      rotation={element.rotation}
      opacity={element.opacity}
      text={element.text}
      fontFamily={element.fontFamily}
      fontSize={element.fontSize}
      fontStyle={`${fontStyle} ${fontWeight}`.trim()}
      fill={element.fill}
      align={element.align}
      lineHeight={element.lineHeight}
      letterSpacing={element.letterSpacing}
      {...drag}
    />
  )
}

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

function ImageNode({ element, ...rest }: ElementNodeProps & { element: ImageElement }) {
  const render = rest.render ?? lightTheme.canvasRender
  const img = useImage(element.src)
  const { dragging, ...drag } = useDragBindings({ element, ...rest }, element.x, element.y)
  const ref = useRef<Konva.Node | null>(null)
  const imgReady = !!img && img.complete && img.naturalWidth > 0
  // Cache key folds load state + the attrs that change the rasterized pixels
  // (src, size, fit). Position/opacity/rotation are post-cache transforms and
  // are deliberately excluded so a drag/opacity change never re-rasterizes.
  useNodeCache(
    ref,
    rest.isSelected,
    dragging,
    rest.zoom,
    `${imgReady}:${element.src}:${element.width}x${element.height}:${element.fit}`,
  )

  if (!img || !img.complete || img.naturalWidth === 0) {
    // Placeholder while loading or broken: a grey rect with the src in its name.
    return (
      <Rect
        ref={ref as React.RefObject<Konva.Rect>}
        name={element.id}
        x={element.x}
        y={element.y}
        width={element.width}
        height={element.height}
        rotation={element.rotation}
        opacity={element.opacity}
        fill={render.brokenFill}
        stroke={render.brokenStroke}
        strokeWidth={1}
        {...drag}
      />
    )
  }

  // Konva handles crop-to-fit natively via crop attrs; we compute them for
  // 'cover' mode. 'contain' and 'fill' use default stretch behavior.
  let cropProps: object = {}
  if (element.fit === 'cover') {
    const srcAspect = img.naturalWidth / img.naturalHeight
    const dstAspect = element.width / element.height
    if (srcAspect > dstAspect) {
      // Source is wider — crop horizontally
      const visibleW = img.naturalHeight * dstAspect
      cropProps = {
        crop: {
          x: (img.naturalWidth - visibleW) / 2,
          y: 0,
          width: visibleW,
          height: img.naturalHeight,
        },
      }
    } else {
      // Source is taller — crop vertically
      const visibleH = img.naturalWidth / dstAspect
      cropProps = {
        crop: {
          x: 0,
          y: (img.naturalHeight - visibleH) / 2,
          width: img.naturalWidth,
          height: visibleH,
        },
      }
    }
  }

  return (
    <KonvaImage
      ref={ref as React.RefObject<Konva.Image>}
      name={element.id}
      x={element.x}
      y={element.y}
      width={element.width}
      height={element.height}
      rotation={element.rotation}
      opacity={element.opacity}
      image={img}
      {...cropProps}
      {...drag}
    />
  )
}

// ---------------------------------------------------------------------------
// Video (renders poster or placeholder — no playback on the canvas surface)
// ---------------------------------------------------------------------------

function VideoNode({ element, ...rest }: ElementNodeProps & { element: VideoElement }) {
  const render = rest.render ?? lightTheme.canvasRender
  // Poster image path — never silently drop; show placeholder when absent.
  const img = useImage(element.posterSrc ?? '')
  const { dragging, ...drag } = useDragBindings({ element, ...rest }, element.x, element.y)
  const ref = useRef<Konva.Node | null>(null)
  const posterReady = !!element.posterSrc && !!img && img.complete && img.naturalWidth > 0
  useNodeCache(
    ref,
    rest.isSelected,
    dragging,
    rest.zoom,
    `${posterReady}:${element.posterSrc ?? ''}:${element.width}x${element.height}`,
  )

  if (!element.posterSrc || !img || !img.complete || img.naturalWidth === 0) {
    return (
      <Rect
        ref={ref as React.RefObject<Konva.Rect>}
        name={element.id}
        x={element.x}
        y={element.y}
        width={element.width}
        height={element.height}
        rotation={element.rotation}
        opacity={element.opacity}
        fill={render.placeholderFill}
        stroke={render.placeholderStroke}
        strokeWidth={1}
        {...drag}
      />
    )
  }

  return (
    <KonvaImage
      ref={ref as React.RefObject<Konva.Image>}
      name={element.id}
      x={element.x}
      y={element.y}
      width={element.width}
      height={element.height}
      rotation={element.rotation}
      opacity={element.opacity}
      image={img}
      {...drag}
    />
  )
}

// ---------------------------------------------------------------------------
// Group (recursive)
// ---------------------------------------------------------------------------

function GroupNode({ element, ...rest }: ElementNodeProps & { element: GroupElement }) {
  const { dragging: _dragging, ...drag } = useDragBindings({ element, ...rest }, element.x, element.y)
  // A group is NOT bitmap-cached: caching a container would flatten its children
  // into one static bitmap and break per-child hit-testing/transform. The win is
  // that each child node (memoized + leaf-cached) keeps its own cache.
  void _dragging
  return (
    <Group
      name={element.id}
      x={element.x}
      y={element.y}
      rotation={element.rotation}
      opacity={element.opacity}
      {...drag}
    >
      {element.children.map((child) => (
        <ElementNode key={child.id} {...rest} element={child} />
      ))}
    </Group>
  )
}
