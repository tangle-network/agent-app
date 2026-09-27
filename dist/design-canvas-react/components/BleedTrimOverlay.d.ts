/**
 * Semi-transparent bleed tint drawn OUTSIDE the page bounds, with trim-mark
 * corner indicators. Renders as an absolutely-positioned div layered over the
 * workspace canvas; node name 'overlay:bleed' lets automated tests target it.
 *
 * Conditionally rendered: parent mounts this only when `showBleed && bleed`.
 * All dimensions are in SCREEN pixels (caller applies the zoom factor).
 */
interface BleedTrimOverlayProps {
    /** Page dimensions in screen pixels (already multiplied by zoom). */
    pageWidthPx: number;
    pageHeightPx: number;
    /** Bleed extents in SCREEN pixels (caller multiplies doc-px by zoom). */
    bleed: {
        top: number;
        right: number;
        bottom: number;
        left: number;
    };
}
export declare function BleedTrimOverlay({ pageWidthPx, pageHeightPx, bleed }: BleedTrimOverlayProps): import("react").JSX.Element;
export {};
