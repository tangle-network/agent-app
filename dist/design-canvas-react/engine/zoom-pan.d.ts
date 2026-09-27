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
import type { ZoomPanMath } from '../contracts';
/** Define configuration options for minimum and maximum zoom levels in a zoom-pan interface */
export interface ZoomPanConfig {
    minZoom: number;
    maxZoom: number;
}
/** Create zoom and pan math utilities enforcing valid zoom range constraints */
export declare function createZoomPanMath(config: ZoomPanConfig): ZoomPanMath;
