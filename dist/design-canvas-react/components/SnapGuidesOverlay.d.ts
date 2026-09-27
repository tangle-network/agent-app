/**
 * Active snap guides rendered as full-page-extent lines during drag gestures.
 * Renders into a dedicated Konva.Layer (name 'overlay:snap') so export logic
 * can exclude it.
 *
 * Guide line colors differ by kind so users can distinguish grid snaps (faint)
 * from element-edge/center snaps (accent) from saved ruler guides (blue).
 */
import type { SnapTarget } from '../contracts';
import { type CanvasRenderPalette } from '../../theme/theme';
interface SnapGuidesOverlayProps {
    /** Page dimensions in document px. */
    pageWidth: number;
    pageHeight: number;
    /** Active vertical guide, or null when not snapping. */
    activeVertical: SnapTarget | null;
    /** Active horizontal guide, or null when not snapping. */
    activeHorizontal: SnapTarget | null;
    /** Screen px per document px — used to compute 1-px-screen stroke widths. */
    zoom: number;
    /** Theme render palette. Omitted → light defaults (byte-identical history). */
    render?: CanvasRenderPalette;
}
export declare function SnapGuidesOverlay({ pageWidth, pageHeight, activeVertical, activeHorizontal, zoom, render, }: SnapGuidesOverlayProps): import("react").JSX.Element | null;
export {};
