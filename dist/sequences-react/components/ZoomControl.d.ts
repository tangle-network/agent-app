/**
 * Zoom slider mapped through `ZoomMath` so equal slider travel feels like
 * equal zoom ratio. The slider's numeric domain is derived from the math
 * itself (`zoomToSlider(minZoom)..zoomToSlider(maxZoom)`) — this component
 * never assumes what scale the engine chose.
 */
import type { ZoomMath } from '../contracts';
export interface ZoomControlProps {
    zoomMath: ZoomMath;
    zoom: number;
    onZoomChange(zoom: number): void;
    /** Fit-to-sequence pixels-per-frame; clicking the readout snaps back to it. */
    fitZoom?: number;
}
export declare function ZoomControl({ zoomMath, zoom, onZoomChange, fitZoom }: ZoomControlProps): import("react").JSX.Element;
