/**
 * Batteries-included composition: DesignCanvas chrome + WorkspaceView sharing
 * one command stack. This is the component products mount.
 *
 * Stack ownership:
 * DesignCanvas (chrome) owns the command stack. WorkspaceView receives that
 * same stack via renderWorkspace(ctx), so every gesture, undo, redo, and
 * layers-panel selection mutation touches exactly one state machine.
 *
 * Thumbnail rendering:
 * Thumbnails are produced imperatively with the Konva JS API (no React tree)
 * on an off-DOM stage at ~96px height. Only geometry + solid-fill shapes are
 * rendered — image nodes are skipped because async loading would require a
 * second pass. Cache key: `${pageId}:${cheapHash(elements)}`. Thumbnail
 * absence is cosmetic; PagesStrip handles a null result gracefully.
 */

import type { SceneDocument } from '../../design-canvas/model'
import type { DesignCanvasProps } from '../contracts'
import { DesignCanvas } from './DesignCanvas'
import { WorkspaceView } from './Workspace'

// ---------------------------------------------------------------------------
// Thumbnail cache
// ---------------------------------------------------------------------------

const THUMBNAIL_HEIGHT_PX = 96

/** Keyed by `pageId:contentHash`. Evicted only when the cache reaches the
 *  hard limit (prevents unbounded growth across long sessions). */
const thumbnailCache = new Map<string, string>()
const THUMBNAIL_CACHE_LIMIT = 200

function evictIfNeeded(): void {
  if (thumbnailCache.size < THUMBNAIL_CACHE_LIMIT) return
  // Drop the oldest 20 % when we hit the ceiling.
  const toDrop = Math.floor(THUMBNAIL_CACHE_LIMIT * 0.2)
  let dropped = 0
  for (const key of thumbnailCache.keys()) {
    if (dropped >= toDrop) break
    thumbnailCache.delete(key)
    dropped++
  }
}

/** Fast, non-cryptographic hash for cache-key generation. Not collision-free —
 *  false hits produce a stale thumbnail (cosmetic only). */
function cheapHash(value: unknown): string {
  const s = JSON.stringify(value) ?? ''
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    // imul handles 32-bit overflow correctly
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** Render a single page to a ~96px-tall data URL using the Konva JS API. The
 *  render is synchronous (no image loading); only geometry + solid fills are
 *  drawn, which is sufficient for thumbnail use.
 *
 *  Returns null when Konva is unavailable (SSR / test environments without
 *  a canvas implementation) or on any render failure — callers must treat
 *  null as "no thumbnail yet" rather than an error. */
async function renderPageThumbnail(page: SceneDocument['pages'][number]): Promise<string | null> {
  const cacheKey = `${page.id}:${cheapHash(page.elements)}`
  const cached = thumbnailCache.get(cacheKey)
  if (cached !== undefined) return cached

  // Lazily import Konva so this file compiles in SSR bundles.
  let Konva: typeof import('konva').default
  try {
    const mod = await import('konva')
    Konva = mod.default
  } catch {
    return null
  }

  const aspectRatio = page.width > 0 ? page.width / page.height : 1
  const thumbH = THUMBNAIL_HEIGHT_PX
  const thumbW = Math.round(thumbH * aspectRatio)
  const scale = page.height > 0 ? thumbH / page.height : 1

  let stage: InstanceType<typeof Konva.Stage> | null = null
  try {
    const container = globalThis.document?.createElement('div')
    if (!container) return null
    container.style.position = 'absolute'
    container.style.left = '-9999px'
    container.style.top = '-9999px'
    globalThis.document.body.appendChild(container)

    stage = new Konva.Stage({ container, width: thumbW, height: thumbH })
    const layer = new Konva.Layer()
    stage.add(layer)

    // Page background
    layer.add(new Konva.Rect({
      x: 0, y: 0,
      width: thumbW,
      height: thumbH,
      fill: page.background,
      listening: false,
    }))

    // Simplified element shapes — geometry + solid fills only; images skipped
    const group = new Konva.Group({ x: 0, y: 0, scaleX: scale, scaleY: scale, listening: false })
    layer.add(group)
    paintElements(Konva, group, page.elements)

    const dataUrl = stage.toDataURL({ mimeType: 'image/png', pixelRatio: 1 })
    evictIfNeeded()
    thumbnailCache.set(cacheKey, dataUrl)
    return dataUrl
  } catch {
    return null
  } finally {
    if (stage) {
      stage.destroy()
      const el = stage.container()
      el.parentNode?.removeChild(el)
    }
  }
}

type KonvaStatic = typeof import('konva').default

function paintElements(
  Konva: KonvaStatic,
  parent: InstanceType<typeof import('konva').default.Group>,
  elements: SceneDocument['pages'][number]['elements'],
): void {
  for (const el of elements) {
    if (!el.visible) continue
    switch (el.kind) {
      case 'rect':
        parent.add(new Konva.Rect({
          x: el.x, y: el.y,
          width: el.width, height: el.height,
          rotation: el.rotation,
          opacity: el.opacity,
          fill: el.fill ?? undefined,
          cornerRadius: el.cornerRadius ?? 0,
          listening: false,
        }))
        break
      case 'ellipse':
        parent.add(new Konva.Ellipse({
          x: el.x + el.width / 2, y: el.y + el.height / 2,
          radiusX: el.width / 2, radiusY: el.height / 2,
          rotation: el.rotation,
          opacity: el.opacity,
          fill: el.fill ?? undefined,
          listening: false,
        }))
        break
      case 'text':
        parent.add(new Konva.Text({
          x: el.x, y: el.y,
          width: el.width,
          rotation: el.rotation,
          opacity: el.opacity,
          text: el.text,
          fontSize: el.fontSize,
          fontFamily: el.fontFamily,
          fill: el.fill,
          align: el.align,
          listening: false,
        }))
        break
      case 'group': {
        const g = new Konva.Group({
          x: el.x, y: el.y,
          rotation: el.rotation,
          opacity: el.opacity,
          listening: false,
        })
        parent.add(g)
        paintElements(Konva, g, el.children)
        break
      }
      // image and video: skip — async loading not viable in sync thumbnail render
      default:
        break
    }
  }
}

// ---------------------------------------------------------------------------
// DesignCanvasEditor
// ---------------------------------------------------------------------------

/**
 * Mount this component to get the full editor: toolbar, rulers, layers panel,
 * pages strip, zoom controls, and the Konva canvas — all sharing one command
 * stack so undo/redo and selection are coherent across every surface.
 */
export function DesignCanvasEditor(props: DesignCanvasProps) {
  return (
    <DesignCanvas
      {...props}
      renderWorkspace={(ctx) => {
        if (!ctx.activePage) return null
        return (
          <WorkspaceView
            stack={ctx.stack}
            activePage={ctx.activePage}
            canWrite={ctx.canWrite}
            onApplyOperations={props.onApplyOperations}
            onSelectionChange={props.onSelectionChange}
            renderAgentPanel={props.renderAgentPanel}
            renderSidePanel={props.renderSidePanel}
            // Shares the chrome's fit ref so F / Fit button trigger workspace
            // fit-to-page through the same callback slot.
            onFitRef={ctx.onFitRef}
            fitOnMount={ctx.fitOnMount}
            onReady={ctx.onReady}
          />
        )
      }}
      renderThumbnail={renderPageThumbnail}
    />
  )
}
