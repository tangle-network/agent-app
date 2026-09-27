/**
 * Canvas zoom controls: fit-to-page, 100%, zoom-out/in buttons, and a percent
 * readout. Stateless — zoom lives in the editor's view state, updated through
 * onZoom.
 */
export interface ZoomControlsProps {
    zoom: number;
    onZoom(zoom: number): void;
    onFit(): void;
    /** Label/aria for the fit action. Defaults to "Fit to screen" — shorter and
     *  matching every other tool's wording for the same action. */
    fitLabel?: string;
}
export declare function ZoomControls({ zoom, onZoom, onFit, fitLabel }: ZoomControlsProps): import("react").JSX.Element;
