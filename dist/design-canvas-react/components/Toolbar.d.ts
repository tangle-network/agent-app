/**
 * Selection-aware toolbar. When elements are selected it shows per-kind
 * attribute controls; when nothing is selected it shows page-props controls.
 * Every number input commits on blur or Enter as a single command (not
 * per-keystroke). The toolbar is stateless beyond transient input focus;
 * the caller owns the command stack.
 *
 * Layout: the root never scrolls horizontally. Global controls (undo/redo +
 * view toggles) are pinned left; the selection/page attribute group wraps so
 * the whole bar fits the editor's center column (viewport minus the w-64 side
 * panel and w-80 agent panel) at 1024–1280px with nothing clipped.
 */
import type { SceneElement, ScenePage } from '../../design-canvas/model';
import type { SceneAttrsPatch } from '../../design-canvas/operations';
import type { PageBleed } from '../../design-canvas/model';
import type { DesignCanvasMode } from '../contracts';
export interface ToolbarProps {
    page: ScenePage;
    selectedElements: SceneElement[];
    canWrite: boolean;
    /** Capability mode. `'review'` (the lean reviewer) hides the view toggles,
     *  page-props controls, and the destructive/structural selection controls
     *  (z-order, group/ungroup, lock, slot, delete), keeping only safe direct
     *  edits: text content, image fit/replace, opacity/rotation, undo/redo.
     *  Defaults to `'edit'` (the full authoring toolbar). */
    mode?: DesignCanvasMode;
    canUndo: boolean;
    canRedo: boolean;
    gridEnabled: boolean;
    snapEnabled: boolean;
    showRulers: boolean;
    showBleed: boolean;
    onUndo(): void;
    onRedo(): void;
    onToggleGrid(): void;
    onToggleSnap(): void;
    onToggleRulers(): void;
    onToggleBleed(): void;
    /** Emit attrs patch for each selected element. */
    onSetAttrs(elementId: string, attrs: SceneAttrsPatch): void;
    onSetPageProps(props: {
        name?: string;
        width?: number;
        height?: number;
        background?: string;
        bleed?: PageBleed | null;
    }): void;
    onSetPageGuides(guides: {
        vertical: number[];
        horizontal: number[];
    }): void;
    onReorder(elementId: string, toIndex: number, ownerLength: number, direction: 'front' | 'back' | 'forward' | 'backward'): void;
    onGroup(elementIds: string[]): void;
    onUngroup(groupId: string): void;
    onDelete(elementIds: string[]): void;
    onBindSlot(elementId: string, slot: string | null): void;
    /** Field label for the page-size control. Defaults to the clearer "Page size";
     *  overridable for consumers that want the older "Preset" wording. */
    pageSizeLabel?: string;
    /** Title for the "turn on print bleed" action. Defaults to "Show print bleed"
     *  (the outcome) rather than the print-shop term "bleed". */
    enableBleedLabel?: string;
}
export declare function Toolbar({ page, selectedElements, canWrite, mode, canUndo, canRedo, gridEnabled, snapEnabled, showRulers, showBleed, onUndo, onRedo, onToggleGrid, onToggleSnap, onToggleRulers, onToggleBleed, onSetAttrs, onSetPageProps, onSetPageGuides, onReorder, onGroup, onUngroup, onDelete, onBindSlot, pageSizeLabel, enableBleedLabel, }: ToolbarProps): import("react").JSX.Element;
