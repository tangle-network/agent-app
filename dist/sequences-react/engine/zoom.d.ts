/**
 * Zoom + viewport coordinate math. Zoom is PIXELS PER FRAME; the slider is a
 * normalized [0, 1] control mapped exponentially (zoom = min·(max/min)^slider)
 * so each slider step multiplies the scale by a constant factor — linear
 * slider feel across a 10x+ range.
 */
import type { ZoomMath } from '../contracts';
/** Define configuration settings for minimum and maximum zoom levels */
export interface ZoomMathConfig {
    minZoom: number;
    maxZoom: number;
}
/** Create a ZoomMath object that validates config and calculates zoom ratio within bounds */
export declare function createZoomMath(config: ZoomMathConfig): ZoomMath;
/** Horizontal viewport: zoom in pixels per frame, scrollLeft in pixels. */
export interface ViewportTransform {
    zoom: number;
    scrollLeft: number;
}
/** Frame → viewport-relative pixel x. Output is fractional; round through
 *  `snapPixel` before drawing. */
export declare function frameToPixel(frame: number, view: ViewportTransform): number;
/** Viewport-relative pixel x → integer frame. Frames are integer positions,
 *  so the result rounds to the nearest frame and floors at 0 (a pointer left
 *  of frame 0 resolves to 0). */
export declare function pixelToFrame(pixel: number, view: ViewportTransform): number;
/** Snap a CSS-pixel value to the device pixel grid so 1px timeline rules
 *  render crisp on fractional-DPR displays. */
export declare function snapPixel(value: number, devicePixelRatio: number): number;
