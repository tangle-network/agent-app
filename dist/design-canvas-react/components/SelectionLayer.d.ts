/**
 * Transformer-based selection layer. Attaches a Konva.Transformer to all
 * currently-selected Konva nodes so the user can resize and rotate them.
 *
 * SINGLE vs. MULTI:
 * - Single selection: resize + rotate.
 * - Multi-selection: rigid resize (keepRatio enforced) + rotate.
 *
 * Rotation snap: within 5° of 0/45/90/135/180 the rotation locks to the
 * nearest cardinal/diagonal (same threshold as the snapRotation pure function).
 *
 * Scale baking: Konva's Transformer sets scaleX/scaleY on the node during
 * a transform gesture. On transformend we read the final x/y/width/height/
 * scaleX/scaleY/rotation from each node, bake scale into width/height, and
 * emit ONE multiSetAttrsCommand. Scale never persists on Konva nodes across
 * render cycles — the next render resets scaleX=scaleY=1 by rendering from
 * model attrs.
 *
 * Special baking per kind:
 * - rect/ellipse/image/video/group: bakeRectTransform (scale → width/height).
 * - line: bakeLineTransform (scale baked into points array).
 * - text: bakeTextTransform (scaleX→width, scaleY→fontSize).
 * - ellipse: center position is adjusted back to top-left model coords via
 *   ellipseTopLeftFromCenter before emitting attrs.
 *
 * Min-size guard: width/height are clamped to ≥ 4px after baking so users
 * cannot collapse an element to zero and lose it.
 *
 * The overlay: prefix on the Transformer name lets export logic skip it.
 */
import type Konva from 'konva';
import type { MultiSetAttrsEntry } from '../engine/commands';
import type { SceneElement } from '../../design-canvas/model';
import { type CanvasRenderPalette } from '../../theme/theme';
export interface SelectionLayerProps {
    /** Konva stage reference to look up selected nodes by name. */
    stageRef: React.RefObject<Konva.Stage | null>;
    /** Selected element ids from editor state. */
    selectedIds: string[];
    /** The model elements corresponding to selectedIds (pre-gesture snapshot). */
    selectedElements: SceneElement[];
    /** Whether the canvas is writable. False → transformer renders but is not interactive. */
    canWrite: boolean;
    /** Emitted when a transform gesture completes with final attrs per element. */
    onTransformEnd(entries: MultiSetAttrsEntry[]): void;
    /** Active page id — every entry in onTransformEnd carries this. */
    pageId: string;
    /** Theme render palette. Omitted → light defaults (byte-identical history). */
    render?: CanvasRenderPalette;
}
export declare function SelectionLayer({ stageRef, selectedIds, selectedElements, canWrite, onTransformEnd, pageId, render, }: SelectionLayerProps): import("react").JSX.Element;
