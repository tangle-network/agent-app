/**
 * Zoom + viewport coordinate math. Zoom is PIXELS PER FRAME; the slider is a
 * normalized [0, 1] control mapped exponentially (zoom = min·(max/min)^slider)
 * so each slider step multiplies the scale by a constant factor — linear
 * slider feel across a 10x+ range.
 */

import type { ZoomMath } from '../contracts'

/** Define configuration settings for minimum and maximum zoom levels */
export interface ZoomMathConfig {
  minZoom: number
  maxZoom: number
}

/** Create a ZoomMath object that validates config and calculates zoom ratio within bounds */
export function createZoomMath(config: ZoomMathConfig): ZoomMath {
  const { minZoom, maxZoom } = config
  if (!Number.isFinite(minZoom) || minZoom <= 0) {
    throw new Error(`minZoom must be a positive finite number, got ${minZoom}`)
  }
  if (!Number.isFinite(maxZoom) || maxZoom <= minZoom) {
    throw new Error(`maxZoom must be finite and greater than minZoom ${minZoom}, got ${maxZoom}`)
  }
  const ratio = maxZoom / minZoom

  return {
    minZoom,
    maxZoom,
    /** Slider clamps into [0, 1]: range inputs can overshoot during fast
     *  drags and the boundary value is always the right answer. */
    sliderToZoom(slider: number): number {
      if (!Number.isFinite(slider)) throw new Error(`slider must be a finite number, got ${slider}`)
      const t = Math.min(1, Math.max(0, slider))
      return minZoom * Math.pow(ratio, t)
    },
    zoomToSlider(zoom: number): number {
      if (!Number.isFinite(zoom) || zoom <= 0) throw new Error(`zoom must be a positive finite number, got ${zoom}`)
      const clamped = Math.min(maxZoom, Math.max(minZoom, zoom))
      return Math.log(clamped / minZoom) / Math.log(ratio)
    },
  }
}

/** Horizontal viewport: zoom in pixels per frame, scrollLeft in pixels. */
export interface ViewportTransform {
  zoom: number
  scrollLeft: number
}

function assertViewport(view: ViewportTransform): void {
  if (!Number.isFinite(view.zoom) || view.zoom <= 0) {
    throw new Error(`viewport zoom must be a positive finite number, got ${view.zoom}`)
  }
  if (!Number.isFinite(view.scrollLeft)) {
    throw new Error(`viewport scrollLeft must be a finite number, got ${view.scrollLeft}`)
  }
}

/** Frame → viewport-relative pixel x. Output is fractional; round through
 *  `snapPixel` before drawing. */
export function frameToPixel(frame: number, view: ViewportTransform): number {
  assertViewport(view)
  if (!Number.isFinite(frame)) throw new Error(`frame must be a finite number, got ${frame}`)
  return frame * view.zoom - view.scrollLeft
}

/** Viewport-relative pixel x → integer frame. Frames are integer positions,
 *  so the result rounds to the nearest frame and floors at 0 (a pointer left
 *  of frame 0 resolves to 0). */
export function pixelToFrame(pixel: number, view: ViewportTransform): number {
  assertViewport(view)
  if (!Number.isFinite(pixel)) throw new Error(`pixel must be a finite number, got ${pixel}`)
  return Math.max(0, Math.round((pixel + view.scrollLeft) / view.zoom))
}

/** Snap a CSS-pixel value to the device pixel grid so 1px timeline rules
 *  render crisp on fractional-DPR displays. */
export function snapPixel(value: number, devicePixelRatio: number): number {
  if (!Number.isFinite(value)) throw new Error(`value must be a finite number, got ${value}`)
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
    throw new Error(`devicePixelRatio must be a positive finite number, got ${devicePixelRatio}`)
  }
  return Math.round(value * devicePixelRatio) / devicePixelRatio
}
