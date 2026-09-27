/**
 * Pure ruler tick-step and label math for the canvas rulers. Nothing here
 * touches React or the DOM — all interaction geometry is extracted so it can
 * be unit-tested without a browser.
 *
 * Canvas rulers show document-coordinate values (CSS px). Tick density adapts
 * to the current zoom so major ticks never sit closer than `minMajorSpacingPx`
 * screen pixels apart. The step table covers typical design zoom ranges; beyond
 * the table the step grows by doubling the last candidate.
 */
/** Define spacing and visibility rules for major and minor ticks in a coordinate system */
export interface TickStep {
    /** Document-coordinate step between major ticks. */
    major: number;
    /** Document-coordinate step between minor ticks (major / 5). */
    minor: number;
    /** True when minor ticks should be drawn (they sit ≥ minMinorSpacingPx apart). */
    drawMinor: boolean;
}
/**
 * Select the major tick step that keeps major ticks ≥ minMajorSpacingPx apart
 * at the given zoom. Minor ticks are rendered when they'd clear minMinorSpacingPx.
 *
 * Both spacing thresholds are SCREEN pixels — the caller provides `zoom` (screen
 * px per document px) so the result is zoom-independent.
 */
export declare function selectTickStep(input: {
    zoom: number;
    minMajorSpacingPx?: number;
    minMinorSpacingPx?: number;
}): TickStep;
/** Define a ruler tick with a position and optional label for measurement markings */
export interface RulerTick {
    /** Position in document coordinates. */
    position: number;
    /** Label text, or null for a minor tick. */
    label: string | null;
}
/**
 * Generate all ticks visible in a ruler of `documentLength` document-px,
 * given the current tick step. The caller clips to the viewport; this produces
 * all ticks for the full document extent so the ruler can be rendered
 * declaratively without a separate clipping pass.
 */
export declare function buildRulerTicks(input: {
    documentLength: number;
    step: TickStep;
}): RulerTick[];
/** Format a document-px position as a compact label: integers stay whole,
 *  decimals are rounded to 1 place. Values ≥ 1000 are compacted to "1k" etc. */
export declare function formatRulerLabel(value: number): string;
/**
 * Convert a screen-coordinate pointer position to a document-coordinate guide
 * drop position, given the ruler's scroll offset and zoom. Used by both the
 * horizontal and vertical ruler drag-guide creation paths.
 *
 * `scrollOffset` is how many document-px of the ruler are scrolled off-screen
 * to the left/top. `pointerScreenPx` is the cursor position in screen px
 * relative to the ruler element's origin.
 */
export declare function screenToDocumentPosition(input: {
    pointerScreenPx: number;
    scrollOffset: number;
    zoom: number;
}): number;
/** Snap a guide drop position to the nearest major tick if within
 *  `snapThresholdPx` document px; otherwise returns the raw position. */
export declare function snapGuideToTick(position: number, step: TickStep, snapThresholdPx: number): number;
/** Index of the topmost element for a given owner length. */
export declare function topIndex(ownerLength: number): number;
/** Move an element one step toward the top (higher index = above in z-order).
 *  Returns the current index unchanged if already at the top. */
export declare function indexForward(current: number, ownerLength: number): number;
/** Move an element one step toward the bottom (lower index = below). Returns
 *  the current index unchanged if already at the bottom. */
export declare function indexBackward(current: number): number;
/** Clamp an arbitrary target index to valid range. */
export declare function clampIndex(target: number, ownerLength: number): number;
