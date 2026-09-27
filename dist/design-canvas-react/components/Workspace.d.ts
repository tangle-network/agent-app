/**
 * Konva Stage host for the design-canvas editor. Renders the active page
 * (background rect + element nodes), wires all interaction gestures, and
 * delegates persistence through the command stack.
 *
 * COORDINATE SYSTEM:
 * The Konva stage sits at (0,0) in screen space. The content Layer group is
 * translated by (panX, panY) and scaled by (zoom, zoom). Document coordinates
 * map to screen via: screenX = panX + docX * zoom.
 *
 * GESTURES (mutually exclusive; escape cancels any live gesture):
 * - Wheel: zoom-to-cursor via ZoomPanMath.zoomAtPoint; setView only.
 * - Middle-button drag / space+drag: pan; setView only.
 * - Empty-space drag: marquee selection; setView only.
 * - Element drag: move via onDragMove preview + onDragEnd command.
 * - Transformer: resize/rotate; handled by SelectionLayer.
 * - Double-click on text: opens InlineTextEditor.
 *
 * KEYBOARD (active when canvas wrapper div is focused):
 * - delete/backspace → deleteElementCommand for each selected id.
 * - arrows → nudge (shift ×10); ONE command emitted on keyup (coalescing).
 * - mod+z / shift+mod+z → undo / redo.
 * - mod+d → duplicate selection at +10,+10 offset.
 * - mod+g → group selection (≥2 elements).
 * - shift+mod+g → ungroup selected group.
 * - mod+a → select all on current page.
 * - escape → cancel live gesture or clear selection.
 *
 * POINTER CAPTURE: marquee and pan gestures call setPointerCapture on the
 * wrapper div so drag events don't escape on fast pointer moves.
 *
 * DEVICEPIXELRATIO: Konva's pixelRatio prop multiplies the backing canvas
 * resolution for crisp rendering at any DPR.
 *
 * Composition:
 * - `WorkspaceView` is the injectable form: receives a pre-created stack and
 *   a guaranteed non-null activePage, commits all gestures through that shared
 *   stack. `DesignCanvasEditor` passes the chrome's stack here so undo/redo
 *   and layers-panel selection stay coherent across both surfaces.
 * - `Workspace` is the standalone wrapper: creates its own stack and renders
 *   WorkspaceView. Existing consumers (tests, bare embeds) mount this without
 *   any chrome.
 */
import type { DesignCanvasProps, ExportTriggerOptions } from '../contracts';
import { createSceneCommandStack } from '../engine/command-stack';
import type { ScenePage } from '../../design-canvas/model';
import { type CanvasRenderPalette } from '../../theme/theme';
export interface WorkspaceViewProps {
    /** The command stack this view commits gestures through. Must be the same
     *  instance the chrome (DesignCanvasEditor) owns so undo/redo and layers-
     *  panel selection are coherent. */
    stack: ReturnType<typeof createSceneCommandStack>;
    /** Active page resolved before render — WorkspaceView has no conditional
     *  hook guards; the caller ensures this is never null. */
    activePage: ScenePage;
    canWrite: boolean;
    onApplyOperations: DesignCanvasProps['onApplyOperations'];
    onSelectionChange?: DesignCanvasProps['onSelectionChange'];
    className?: string;
    /** Ref the chrome fills with a fit-page callback. The chrome calls it on F /
     *  Fit button; when injected via DesignCanvasEditor the ref is shared. */
    onFitRef?: React.MutableRefObject<(() => void) | null>;
    /** Host export hook. When set, the workspace fills `onExportRef` with a
     *  callback that renders the stage to a data URL and forwards the result. */
    onExport?: DesignCanvasProps['onExport'];
    /** Ref the workspace fills with an export callback `(opts) => void`. The
     *  chrome's Export control calls it; the workspace owns the Konva stage so it
     *  produces the data URL here. Filled only when `onExport` is also set. */
    onExportRef?: React.MutableRefObject<((opts: ExportTriggerOptions) => void) | null>;
    /** Fit the active page to the viewport once, on the first non-zero measurement. Default true. */
    fitOnMount?: boolean;
    /** Called once after the first real (non-zero) measurement, after the initial fit is applied (or skipped). */
    onReady?(): void;
    /** Konva render palette. Omitted → light defaults (byte-identical history). */
    render?: CanvasRenderPalette;
    /** Show the branded in-canvas empty state (three doors) while the active page
     *  has no elements and the user can write. Default true. Set false to keep a
     *  bare blank stage (e.g. when restoring a saved-but-intentionally-empty page). */
    showEmptyState?: boolean;
    /** Focus/open the agent from the empty state's "Ask the agent" door. When
     *  omitted that door is hidden — there is no agent surface to send them to. */
    onAskAgent?(): void;
}
export declare function WorkspaceView({ canWrite, onApplyOperations, onSelectionChange, className, stack, activePage, onFitRef, onExport, onExportRef, fitOnMount, onReady, render, showEmptyState, onAskAgent, }: WorkspaceViewProps): import("react").JSX.Element;
/**
 * Self-contained Konva workspace that creates its own command stack. Mount
 * this when you want the canvas without the toolbar/rulers/pages-strip chrome.
 *
 * Products that want the full editor (chrome + workspace sharing one stack)
 * should mount `DesignCanvasEditor` instead.
 */
export declare function Workspace(props: DesignCanvasProps): import("react").JSX.Element | null;
