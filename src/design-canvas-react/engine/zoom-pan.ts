/**
 * Zoom + pan coordinate math for the design-canvas editor. Zoom is pixels-per-
 * document-px (e.g. 2 = 200% magnification). The key invariant for wheel-zoom
 * is that the document point under the cursor stays fixed in screen space:
 *
 *   docPoint = (screenPoint - pan) / zoom
 *   newPan   = screenPoint - docPoint * newZoom
 *
 * This module is pure math — no DOM, no Konva, no React.
 */

import type { ZoomPanMath } from '../contracts'

/** Define configuration options for minimum and maximum zoom levels in a zoom-pan interface */
export interface ZoomPanConfig {
  minZoom: number
  maxZoom: number
}

/** Create zoom and pan math utilities enforcing valid zoom range constraints */
export function createZoomPanMath(config: ZoomPanConfig): ZoomPanMath {
  const { minZoom, maxZoom } = config
  if (!Number.isFinite(minZoom) || minZoom <= 0) {
    throw new Error(`minZoom must be a positive finite number, got ${minZoom}`)
  }
  if (!Number.isFinite(maxZoom) || maxZoom <= minZoom) {
    throw new Error(`maxZoom must be finite and greater than minZoom (${minZoom}), got ${maxZoom}`)
  }

  return {
    minZoom,
    maxZoom,

    zoomAtPoint(
      state: { zoom: number; panX: number; panY: number },
      factor: number,
      screenX: number,
      screenY: number,
    ): { zoom: number; panX: number; panY: number } {
      if (!Number.isFinite(factor) || factor <= 0) {
        throw new Error(`zoomAtPoint: factor must be a positive finite number, got ${factor}`)
      }
      if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) {
        throw new Error(`zoomAtPoint: screenX/screenY must be finite numbers`)
      }
      if (!Number.isFinite(state.zoom) || state.zoom <= 0) {
        throw new Error(`zoomAtPoint: state.zoom must be a positive finite number, got ${state.zoom}`)
      }

      const newZoom = Math.min(maxZoom, Math.max(minZoom, state.zoom * factor))

      // The document point under the cursor must remain fixed:
      //   docX = (screenX - panX) / zoom
      //   newPanX = screenX - docX * newZoom
      const docX = (screenX - state.panX) / state.zoom
      const docY = (screenY - state.panY) / state.zoom
      const panX = screenX - docX * newZoom
      const panY = screenY - docY * newZoom

      return { zoom: newZoom, panX, panY }
    },

    fitPage(
      page: { width: number; height: number },
      viewport: { width: number; height: number },
      paddingPx = 48,
    ): { zoom: number; panX: number; panY: number } {
      if (!Number.isFinite(page.width) || page.width <= 0) {
        throw new Error(`fitPage: page.width must be a positive finite number, got ${page.width}`)
      }
      if (!Number.isFinite(page.height) || page.height <= 0) {
        throw new Error(`fitPage: page.height must be a positive finite number, got ${page.height}`)
      }
      if (!Number.isFinite(viewport.width) || viewport.width <= 0) {
        throw new Error(`fitPage: viewport.width must be a positive finite number, got ${viewport.width}`)
      }
      if (!Number.isFinite(viewport.height) || viewport.height <= 0) {
        throw new Error(`fitPage: viewport.height must be a positive finite number, got ${viewport.height}`)
      }
      if (!Number.isFinite(paddingPx) || paddingPx < 0) {
        throw new Error(`fitPage: paddingPx must be a non-negative finite number, got ${paddingPx}`)
      }

      const availW = viewport.width - paddingPx * 2
      const availH = viewport.height - paddingPx * 2
      const zoom = Math.min(maxZoom, Math.max(minZoom, Math.min(availW / page.width, availH / page.height)))

      // Center the page in the viewport
      const panX = (viewport.width - page.width * zoom) / 2
      const panY = (viewport.height - page.height * zoom) / 2

      return { zoom, panX, panY }
    },

    documentToScreen(
      state: { zoom: number; panX: number; panY: number },
      x: number,
      y: number,
    ): { x: number; y: number } {
      return { x: x * state.zoom + state.panX, y: y * state.zoom + state.panY }
    },

    screenToDocument(
      state: { zoom: number; panX: number; panY: number },
      x: number,
      y: number,
    ): { x: number; y: number } {
      if (!Number.isFinite(state.zoom) || state.zoom === 0) {
        throw new Error(`screenToDocument: zoom must be a non-zero finite number, got ${state.zoom}`)
      }
      return { x: (x - state.panX) / state.zoom, y: (y - state.panY) / state.zoom }
    },
  }
}
