/**
 * Pure layer-tree helpers: flatten a page's element array into an ordered list
 * for the LayersPanel, preserving group nesting. Extracted so render order,
 * depth, and selection math can be unit-tested independently of React.
 */
import type { SceneElement, ScenePage } from '../../design-canvas/model';
/** Describe a layer row with its element, depth, grouping, ownership, and parent group details */
export interface LayerRow {
    element: SceneElement;
    depth: number;
    /** True when this row is a group whose children follow it in the list. */
    isGroup: boolean;
    /** Index within its owner (page.elements or group.children). */
    ownerIndex: number;
    /** Length of the owner array — needed for z-order bound math. */
    ownerLength: number;
    /** Id of the containing group, or null for page-root elements. */
    parentGroupId: string | null;
}
/**
 * Flatten `page.elements` into display order for the layers panel.
 *
 * Z-order is bottom→top in the element array; the layers panel shows
 * top→bottom (highest z-index first). A group row precedes its children
 * (the group is "above" its children in the panel, reflecting that the group
 * node itself paints last in Konva when empty; children paint inside it).
 *
 * Depth increases by 1 for each group level, starting at 0 for page-root
 * elements. Groups are expanded; collapsed state is a view concern the caller
 * tracks separately.
 */
export declare function flattenLayerTree(page: ScenePage): LayerRow[];
/** The maximum number of rows the layers panel renders before truncating. */
export declare const LAYERS_PANEL_ROW_LIMIT = 500;
