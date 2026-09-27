/**
 * Page size presets, channel-size output presets, and export math for the
 * design canvas.
 *
 * Size presets (SizePreset / SIZE_PRESETS) describe page dimensions for the
 * new-page dialog. Export presets (ExportPreset / EXPORT_PRESETS) pin pixel
 * ratio, output dimensions, bleed, and format for the export dialog and the
 * MCP export tool. Channel presets (ChannelPreset / CHANNEL_PRESETS) are the
 * fixed output resolutions the export UI offers; `scaleForPreset` + the
 * letterbox helper derive Konva stage parameters from them.
 *
 * All dimensions are CSS pixels at 96 DPI unless noted otherwise.
 */
import type { Bounds, ScenePage } from './model';
/** Define size presets with identifiers, labels, categories, and dimensions for various media types */
export interface SizePreset {
    id: string;
    label: string;
    category: 'social' | 'print' | 'presentation' | 'custom';
    width: number;
    height: number;
}
/** Provide predefined size presets for social, presentation, and print categories */
export declare const SIZE_PRESETS: readonly SizePreset[];
/** Resolve a size preset by its identifier or return null if not found */
export declare function findPreset(id: string): SizePreset | null;
/** Match a (width, height) pair against the preset table. Returns the first
 *  exact match or null — used to drive the dropdown selection indicator. */
export declare function matchPreset(width: number, height: number): SizePreset | null;
/** Define supported image export formats as PNG or JPEG */
export type ExportFormat = 'png' | 'jpeg';
/**
 * Export quality preset — pins pixel density, optional output dimensions,
 * bleed inclusion, and raster format so callers pass a preset id rather than
 * a full parameter bag.
 *
 * `outputWidth` / `outputHeight`: when non-null, the pixel ratio is derived
 * from the crop rect width (see `scaleForPreset`) so the output is exactly
 * this many pixels wide. When null, `pixelRatio` applies directly.
 */
export interface ExportPreset {
    name: string;
    /** Target pixels-per-document-px for stage.toDataURL. */
    pixelRatio: number;
    outputWidth: number | null;
    outputHeight: number | null;
    /** Whether bleed margins are included in the crop rect. */
    includeBleed: boolean;
    format: ExportFormat;
}
/** Provide predefined export configurations for various social media and image formats */
export declare const EXPORT_PRESETS: Record<string, ExportPreset>;
/** Define crop rectangle coordinates and dimensions for exporting content within page bounds */
export interface ExportCropRect {
    /** Page-coordinate origin. Negative when bleed extends outside page bounds. */
    x: number;
    y: number;
    width: number;
    height: number;
}
/**
 * Crop rectangle in page coordinates for a given page, optionally expanded to
 * include bleed margins. Bleed extends OUTSIDE the page bounds, so the origin
 * goes negative when bleed is included.
 *
 * When `includeBleed` is true but `page.bleed` is null, the page rect is
 * returned unchanged — the caller must not assume symmetric expansion.
 */
export declare function bleedAwareExportBounds(page: ScenePage, includeBleed: boolean): ExportCropRect;
/**
 * Pixel ratio for stage.toDataURL given a crop rect and an export preset.
 *
 * When the preset pins `outputWidth`, the ratio is derived from the crop rect
 * width so the final raster is exactly that many pixels wide. When there is no
 * output pin, the preset's declared `pixelRatio` is returned directly.
 *
 * The crop rect must already account for bleed inclusion before this call.
 */
export declare function scaleForPreset(preset: ExportPreset, cropRect: ExportCropRect): number;
/** Define a preset configuration for a channel including its id, label, width, and height */
export interface ChannelPreset {
    id: string;
    label: string;
    width: number;
    height: number;
}
/**
 * Fixed output resolution presets for the channel/platform export dialog.
 * Width × height are OUTPUT pixels (the raster the export produces), not page
 * CSS px — they describe the target delivery format, not the canvas layout.
 * The a4_print_2480x3508 preset corresponds to A4 at 300 dpi.
 */
export declare const CHANNEL_PRESETS: readonly ChannelPreset[];
/** Resolve a valid channel preset identifier from the predefined channel presets array */
export type ChannelPresetId = (typeof CHANNEL_PRESETS)[number]['id'];
/** Throws when the id is unknown — callers should only pass ids sourced from
 *  `CHANNEL_PRESETS`. */
export declare function requireChannelPreset(id: string): ChannelPreset;
/** Define the pixel ratio and horizontal offset for scaling a Konva stage to a channel preset size */
export interface ChannelScaleResult {
    /**
     * Konva stage pixelRatio: the stage logical size stays at page dimensions;
     * the backing canvas renders at `pixelRatio × page` px. Setting Konva's
     * pixelRatio to this value yields an output canvas exactly
     * `channelPreset.width × channelPreset.height` pixels.
     */
    pixelRatio: number;
    /**
     * Horizontal letterbox offset in PAGE-coordinate px. Add to the stage x
     * translation so the page is centered horizontally in the output frame.
     * Zero when the page fills the full width after scaling.
     */
    offsetX: number;
    /**
     * Vertical letterbox offset in PAGE-coordinate px. Add to the stage y
     * translation. Zero when the page fills the full height.
     */
    offsetY: number;
    fit: 'contain';
}
/**
 * Computes the Konva stage parameters to render `page` centered inside
 * `channelPreset` without cropping (contain / letterbox).
 *
 * Exact-ratio fast path: when page and preset share the same aspect ratio
 * (within 1e-9 floating-point tolerance) both offsets are 0 and pixelRatio
 * is exact.
 *
 * Example — 1080×1080 page into 1920×1080 preset:
 *   scaleX = 1920/1080 ≈ 1.7778, scaleY = 1080/1080 = 1.0
 *   pixelRatio = 1.0, rendered page = 1080×1080 px
 *   offsetX = (1920 − 1080) / 2 / 1.0 = 420 page-px, offsetY = 0
 */
export declare function scalePageForChannelPreset(page: Pick<ScenePage, 'width' | 'height'>, channelPreset: ChannelPreset): ChannelScaleResult;
/**
 * Export rectangle in page coordinates that includes bleed margins when
 * present. When `page.bleed` is null, returns the trim rectangle (origin 0,0;
 * size = page dimensions).
 *
 * The bleed rectangle extends OUTSIDE the page: x and y are negative (bleed
 * bleeds off the left/top edge), width and height exceed the page by the
 * combined bleed on each axis. Pass into Konva's clip/export bounds to
 * include the bleed zone in the render.
 *
 * Named `bleedAwareExportRect` to avoid collision with the two-arg
 * `bleedAwareExportBounds(page, includeBleed)` above.
 */
export declare function bleedAwareExportRect(page: Pick<ScenePage, 'width' | 'height' | 'bleed'>): Bounds;
