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
import { type CanvasRenderPalette } from '../../theme/theme';
import type { SceneElement } from '../../design-canvas/model';
export interface ElementNodeProps {
    element: SceneElement;
    isSelected: boolean;
    zoom: number;
    /** Theme render palette. Omitted → light defaults (byte-identical history). */
    render?: CanvasRenderPalette;
    onClick?(elementId: string): void;
    onDragStart?(elementId: string): void;
    onDragMove?(elementId: string, dx: number, dy: number): void;
    onDragEnd?(elementId: string, finalX: number, finalY: number): void;
    onDoubleClick?(elementId: string): void;
}
declare function ElementNodeImpl(props: ElementNodeProps): import("react").JSX.Element | null;
/**
 * Memoized so a `stack.notify()` (fired ~120/s during a pan/marquee) that
 * re-renders WorkspaceView does NOT re-render every element. With stable
 * handler identities supplied by WorkspaceView, an ElementNode re-renders only
 * when its OWN `element` reference, `isSelected`, `zoom`, or `render` palette
 * change — i.e. when it actually moved, was (de)selected, or the view scaled.
 * Pan-only frames change none of these props, so the N nodes stay reconciled.
 */
export declare const ElementNode: import("react").MemoExoticComponent<typeof ElementNodeImpl>;
export {};
