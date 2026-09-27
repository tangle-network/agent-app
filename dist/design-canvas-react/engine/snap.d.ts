/**
 * 2-axis snap engine for the design-canvas editor. Targets come from element
 * AABBs (edges + centers), page edges + center, saved guides, and grid lines
 * near the moving bounds. Grid lines are generated lazily in the neighborhood
 * of the moving element, not the full page — avoids allocating thousands of
 * targets on large pages with fine grids.
 *
 * Threshold is a SCREEN distance (pixels), divided by zoom to convert to
 * document units — what "feels close" is a screen distance.
 *
 * Tie-breaking: non-grid kinds beat grid on equal distance; among equals of
 * the same priority the first in iteration order wins.
 */
import type { Bounds, ScenePage } from '../../design-canvas/model';
import type { SnapEngine, SnapTarget } from '../contracts';
/** Build a SnapEngine instance to manage snapping targets and behavior within an editor scene */
export declare function createSnapEngine(): SnapEngine;
/** Generate grid line targets within a neighborhood around the moving bounds.
 *  Call this and append to `SnapTargets.vertical`/`horizontal` before
 *  passing to `apply()` when `state.gridEnabled`. */
export declare function collectGridTargets(bounds: Bounds, gridSize: number, page: ScenePage, thresholdDocPx: number): {
    vertical: SnapTarget[];
    horizontal: SnapTarget[];
};
