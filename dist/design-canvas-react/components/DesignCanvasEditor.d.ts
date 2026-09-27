/**
 * Batteries-included composition: DesignCanvas chrome + WorkspaceView sharing
 * one command stack. This is the component products mount.
 *
 * Stack ownership:
 * DesignCanvas (chrome) owns the command stack. WorkspaceView receives that
 * same stack via renderWorkspace(ctx), so every gesture, undo, redo, and
 * layers-panel selection mutation touches exactly one state machine.
 *
 * Thumbnail rendering:
 * Thumbnails are produced imperatively with the Konva JS API (no React tree)
 * on an off-DOM stage at ~96px height. Only geometry + solid-fill shapes are
 * rendered — image nodes are skipped because async loading would require a
 * second pass. Cache key: `${pageId}:${cheapHash(elements)}`. Thumbnail
 * absence is cosmetic; PagesStrip handles a null result gracefully.
 */
import type { DesignCanvasProps } from '../contracts';
/**
 * Mount this component to get the full editor: toolbar, rulers, layers panel,
 * pages strip, zoom controls, and the Konva canvas — all sharing one command
 * stack so undo/redo and selection are coherent across every surface.
 */
export declare function DesignCanvasEditor(props: DesignCanvasProps): import("react").JSX.Element;
