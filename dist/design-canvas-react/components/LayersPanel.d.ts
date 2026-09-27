/**
 * Layers panel — reverse-z list of the active page's elements. Highest z-index
 * is at the top. Groups show their children indented beneath them. Clicking
 * selects an element; meta-click adds to selection. Double-clicking the name
 * opens an inline rename input. Eye and lock icons toggle visibility/locked.
 * Rows can be drag-reordered within the list (siblings only; cross-group reorder
 * is a pending integrator concern). Capped at LAYERS_PANEL_ROW_LIMIT rows.
 */
import type { SceneElement, ScenePage } from '../../design-canvas/model';
export interface LayersPanelProps {
    page: ScenePage;
    selectedElementIds: string[];
    canWrite: boolean;
    /** Emit a set_attrs command for the given element. */
    onSetAttrs(elementId: string, attrs: Partial<Pick<SceneElement, 'name' | 'visible' | 'locked'>>): void;
    /** Emit a reorder_element command. */
    onReorder(elementId: string, toIndex: number): void;
    onSelect(elementId: string, additive: boolean): void;
}
export declare function LayersPanel({ page, selectedElementIds, canWrite, onSetAttrs, onReorder, onSelect }: LayersPanelProps): import("react").JSX.Element;
