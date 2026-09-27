/**
 * Compact Export control for the editor chrome's top-right slot. A single
 * button opens a small popover to choose format (PNG/JPEG) and scale (1x/2x);
 * confirming calls `onExport({ format, pixelRatio })`.
 *
 * The chrome is Konva-free, so this control does NOT render the image — it only
 * collects the format/scale and delegates to the workspace (which owns the
 * stage) via the callback the DesignCanvas shell wires through `onExportRef`.
 *
 * Tokens/glyphs follow the canvas convention: CSS-var design tokens and inline
 * SVG glyphs, no icon-library or browser-default `<select>`.
 */
import type { ExportTriggerOptions } from '../contracts';
export interface ExportControlProps {
    /** Pre-selected format/scale when the popover opens. Default PNG @ 1x. */
    defaults?: ExportTriggerOptions;
    /** Called with the chosen format/scale when the user confirms. */
    onExport(opts: ExportTriggerOptions): void;
    className?: string;
}
export declare function ExportControl({ defaults, onExport, className }: ExportControlProps): import("react").JSX.Element;
