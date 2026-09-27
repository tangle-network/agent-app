/**
 * Horizontal (top) and vertical (left) canvas rulers. Each ruler:
 * - Draws zoom-scaled tick marks via `buildRulerTicks` / `selectTickStep`.
 * - Shows a pointer-position indicator (a hairline that follows the cursor).
 * - Supports guide creation by dragging OUT of the ruler: a live preview line
 *   appears while dragging; on drop a `set_page_guides` command is emitted.
 * - Existing guides that are dragged BACK into the ruler are deleted.
 * - Renders saved guides persistently, Figma-style: a marker in the ruler
 *   track at each guide position, plus a thin line spanning the canvas (the
 *   GuidesCanvasOverlay sibling, aligned with the track coordinate space).
 *
 * All interaction math lives in ruler-math.ts and is testable without a DOM.
 * The rulers themselves are pure DOM (no Konva); they sit in a CSS grid slot
 * next to the workspace canvas.
 */
import type { PageGuides } from '../../design-canvas/model';
export interface RulersProps {
    /** Page width in document px. */
    pageWidth: number;
    /** Page height in document px. */
    pageHeight: number;
    zoom: number;
    /** How many doc-px of the canvas are scrolled off-screen left/top. */
    scrollLeft: number;
    scrollTop: number;
    showRulers: boolean;
    guides: PageGuides;
    /** Emitted when the user drops a guide or deletes one back into the ruler. */
    onGuidesChange(guides: PageGuides): void;
}
export declare function Rulers({ pageWidth, pageHeight, zoom, scrollLeft, scrollTop, showRulers, guides, onGuidesChange }: RulersProps): import("react").JSX.Element | null;
