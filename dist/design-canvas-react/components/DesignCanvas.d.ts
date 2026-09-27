/**
 * Root editor shell. Products mount exactly this component. Layout mirrors
 * Polotno: optional left side panel | main column | optional right agent panel.
 *
 * Main column stacks top→bottom:
 *   Toolbar (undo/redo, view toggles, selection attrs, page props)
 *   Rulers + Workspace  (the Workspace is injected by the integrator via the
 *                        `renderWorkspace` prop — it owns Konva and is Konva-
 *                        specific; this chrome stays canvas-free)
 *   bottom row: PagesStrip + ZoomControls
 *
 * Command lifecycle:
 * - The command stack lives here; every panel receives callbacks, never the
 *   stack itself.
 * - `onApplyOperations` is called optimistically after every command. If it
 *   rejects, the command is rolled back locally. If it resolves with a fresh
 *   `document`, the stack rebases via `stack.reset(document)` — this preserves
 *   history while reconciling server-minted ids or normalised values.
 * - `setView` (zoom/pan/selection/toggles) never enters history.
 * - Keyboard: Mod+Z undo · Shift+Mod+Z / Mod+Y redo · Delete/Backspace deletes
 *   the selection · F fits the page (forwarded to workspace via ref).
 */
import type { SceneDocument } from '../../design-canvas/model';
import type { DesignCanvasProps, ExportTriggerOptions } from '../contracts';
import { createSceneCommandStack } from '../engine/command-stack';
/** Callers inject a workspace renderer so this chrome stays Konva-free. The
 *  workspace occupies the scrollable area between the rulers and the bottom bar. */
export interface DesignCanvasFullProps extends DesignCanvasProps {
    /**
     * Render the Konva canvas workspace into the slot this shell provides.
     * The shell passes viewport dimensions, view-state, and the shared command
     * stack so `WorkspaceView` can commit gestures through the same stack the
     * chrome uses for undo/redo and layers-panel selection.
     *
     * `onFitRef` is a ref the workspace fills with a fit-page callback; the
     * shell calls it when the user presses F or clicks the Fit button.
     */
    renderWorkspace(ctx: {
        document: SceneDocument;
        activePageId: string;
        selectedElementIds: string[];
        zoom: number;
        panX: number;
        panY: number;
        gridEnabled: boolean;
        gridSize: number;
        snapEnabled: boolean;
        showBleed: boolean;
        canWrite: boolean;
        /** The chrome's command stack. Pass to WorkspaceView so gestures, undo,
         *  and layers-panel selection share a single state machine. */
        stack: ReturnType<typeof createSceneCommandStack>;
        activePage: SceneDocument['pages'][number] | undefined;
        onFitRef: React.MutableRefObject<(() => void) | null>;
        /** A ref the workspace fills with an export callback. The chrome's Export
         *  control calls it with the chosen format/scale; the workspace renders the
         *  Konva stage to a data URL and forwards the result to `onExport`. Filled
         *  only when `onExport` is wired (the workspace skips it otherwise). */
        onExportRef: React.MutableRefObject<((opts: ExportTriggerOptions) => void) | null>;
        /** Forwarded from DesignCanvasProps. Default true: WorkspaceView fits the
         *  active page to the viewport once, on the first non-zero measurement. */
        fitOnMount?: boolean;
        /** Forwarded from DesignCanvasProps. Fires once after the first real
         *  measurement, after the initial fit is applied (or skipped). */
        onReady?(): void;
        /** Forwarded from DesignCanvasProps. The Konva render palette; the
         *  Konva-free chrome passes it straight through to the workspace. */
        render?: DesignCanvasProps['render'];
        /** Forwarded from DesignCanvasProps. Toggles the branded in-canvas empty
         *  state and its agent door. */
        showEmptyState?: DesignCanvasProps['showEmptyState'];
        onAskAgent?: DesignCanvasProps['onAskAgent'];
        onZoomChange(zoom: number): void;
        onPanChange(panX: number, panY: number): void;
        onSelectElements(ids: string[], additive: boolean): void;
    }): React.ReactNode;
    /**
     * Generates page thumbnails for the PagesStrip. Injected by the integrator
     * (who has Konva access) so the chrome doesn't import Konva directly.
     */
    renderThumbnail(page: SceneDocument['pages'][number]): Promise<string | null>;
}
export declare function DesignCanvas({ document: initialDocument, rev: initialRev, canWrite, mode, onApplyOperations, onSelectionChange, renderAgentPanel, renderSidePanel, onExport, exportDefaults, className, fitOnMount, onReady, render, showEmptyState, onAskAgent, pageSizeLabel, enableBleedLabel, fitLabel, renderWorkspace, renderThumbnail, }: DesignCanvasFullProps): import("react").JSX.Element;
