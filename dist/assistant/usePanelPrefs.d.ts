/**
 * Persisted, user-adjustable presentation preferences for the assistant drawer:
 * its width (drag-to-resize) and a font-size scale. Both survive reloads via
 * localStorage and are clamped to sane bounds. Kept out of the components so the
 * SSR-safe persistence and clamping live in one place and stay testable.
 */
/** Narrowest the drawer may be dragged — below this the chat is unusable. */
export declare const MIN_PANEL_WIDTH = 360;
/** Default drawer width — matches the previous fixed `max-w-md` (28rem). */
export declare const DEFAULT_PANEL_WIDTH = 448;
/** Font-size scale bounds and step for the A−/A+ control. 1 = the design
 *  default; the panel applies this as a CSS `zoom` on the transcript so the
 *  whole conversation scales uniformly. */
export declare const MIN_FONT_SCALE = 0.875;
export declare const MAX_FONT_SCALE = 1.5;
export declare const DEFAULT_FONT_SCALE = 1;
interface PanelWidth {
    /** Current width in px. Apply as an inline `width` only on desktop. */
    width: number;
    /** Current max allowed width in px (viewport-derived; updates on resize).
     *  Exposed for an accurate `aria-valuemax` on the resize control. */
    maxWidth: number;
    /** Set an absolute width (clamped + persisted). Use on drag end / discrete
     *  changes — NOT on every drag tick. */
    setWidth: (next: number) => void;
    /** Set an absolute width (clamped, NOT persisted). Use during a live drag so
     *  the panel tracks the pointer without thrashing localStorage every tick. */
    previewWidth: (next: number) => void;
    /** Nudge by a delta (keyboard resize); clamped + persisted. */
    nudgeWidth: (deltaPx: number) => void;
}
/**
 * The drawer's persisted width. Initialized to the default so first render is
 * stable; the stored value is read in an effect and applied after mount.
 * Re-clamps on viewport resize so a stored width can never exceed the current
 * window, and tracks the live max for the resize control's ARIA bounds.
 */
export declare function usePanelWidth(): PanelWidth;
interface FontScale {
    scale: number;
    increase: () => void;
    decrease: () => void;
    canIncrease: boolean;
    canDecrease: boolean;
}
/** The panel's persisted font-size scale, with bounded A−/A+ controls. */
export declare function useFontScale(): FontScale;
/**
 * Whether the viewport is at the `md` breakpoint or wider. The drawer is a
 * full-screen sheet below `md` (no resize), and a width-constrained side panel
 * at/above it. Defaults to `true` for SSR/first paint — the dialog only renders
 * after a client interaction, by which point the effect has corrected it.
 */
export declare function useIsDesktop(): boolean;
export {};
