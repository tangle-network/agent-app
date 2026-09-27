/**
 * Grid overlay rendered beneath page content. The whole grid is painted by a
 * SINGLE Konva node — a custom Shape whose `sceneFunc` strokes every grid line
 * in one pass — rather than one Konva.Line per line. At ~hundreds of lines on a
 * page this turns a per-pan-frame reconciliation of hundreds of React/Konva
 * nodes into a single node whose only changing props are the transform; panning
 * no longer churns the scene graph.
 *
 * Grid lines are skipped entirely when they would be closer than 4 screen
 * pixels apart — below that density the grid becomes visual noise rather than
 * guidance (gridVisible density-skip, unchanged).
 *
 * COORDINATE SYSTEM: the lines are authored in document space and wrapped in a
 * Group carrying the SAME (panX, panY, zoom) transform the content layer uses,
 * so the grid tracks the page exactly on pan and zoom. A Konva.Layer cannot
 * live inside a Group, so the transform is applied to an inner Group, not the
 * Layer. The grid is its own Layer (not merged into the content Layer) so the
 * content draws on top without per-frame z-ordering churn.
 *
 * EXPORT EXCLUSION: the Layer carries the name prefix 'overlay:' and the Shape
 * is named 'overlay:grid-shape' so export logic excludes the whole grid from
 * rasterization.
 */
export interface GridLayerProps {
    /** Page width in document px. */
    pageWidth: number;
    /** Page height in document px. */
    pageHeight: number;
    /** Document px between grid lines. */
    gridSize: number;
    /** Screen px per document px. */
    zoom: number;
    /** Horizontal pan offset in screen px (content Group x). */
    panX: number;
    /** Vertical pan offset in screen px (content Group y). */
    panY: number;
    /** Grid line color. */
    color?: string;
    /** Grid line opacity (0–1). */
    opacity?: number;
}
/** Document-space x positions of every vertical grid line on the page. Pure so
 *  the single-Shape sceneFunc and tests share one definition (no drift). */
export declare function gridVerticalLines(pageWidth: number, gridSize: number): number[];
/** Document-space y positions of every horizontal grid line on the page. */
export declare function gridHorizontalLines(pageHeight: number, gridSize: number): number[];
export declare function GridLayer({ pageWidth, pageHeight, gridSize, zoom, panX, panY, color, opacity, }: GridLayerProps): import("react").JSX.Element | null;
