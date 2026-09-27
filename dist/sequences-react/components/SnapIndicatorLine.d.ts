/**
 * Vertical accent line at the frame an in-flight drag is snapped to. Rendered
 * inside the horizontally-scrolled track area so its x position is plain
 * frame * zoom; visibility is owned by the editor (non-null point = visible).
 */
import type { SnapPoint } from '../contracts';
export interface SnapIndicatorLineProps {
    point: SnapPoint | null;
    zoom: number;
}
export declare function SnapIndicatorLine({ point, zoom }: SnapIndicatorLineProps): import("react").JSX.Element | null;
