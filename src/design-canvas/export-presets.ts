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

import type { Bounds, PageBleed, ScenePage } from './model'

/** Define size presets with identifiers, labels, categories, and dimensions for various media types */
export interface SizePreset {
  id: string
  label: string
  category: 'social' | 'print' | 'presentation' | 'custom'
  width: number
  height: number
}

/** Provide predefined size presets for social, presentation, and print categories */
export const SIZE_PRESETS: readonly SizePreset[] = [
  // Social
  { id: 'instagram-square', label: 'Instagram — Square', category: 'social', width: 1080, height: 1080 },
  { id: 'instagram-portrait', label: 'Instagram — Portrait', category: 'social', width: 1080, height: 1350 },
  { id: 'instagram-story', label: 'Instagram Story', category: 'social', width: 1080, height: 1920 },
  { id: 'twitter-post', label: 'X / Twitter Post', category: 'social', width: 1200, height: 675 },
  { id: 'linkedin-post', label: 'LinkedIn Post', category: 'social', width: 1200, height: 627 },
  { id: 'facebook-post', label: 'Facebook Post', category: 'social', width: 1200, height: 630 },
  { id: 'youtube-thumbnail', label: 'YouTube Thumbnail', category: 'social', width: 1280, height: 720 },
  { id: 'og-image', label: 'Open Graph Image', category: 'social', width: 1200, height: 630 },
  // Presentation
  { id: 'slide-16-9', label: 'Slide — 16:9', category: 'presentation', width: 1920, height: 1080 },
  { id: 'slide-4-3', label: 'Slide — 4:3', category: 'presentation', width: 1024, height: 768 },
  // Print (96 DPI px equivalents of A4, Letter — products may scale at export)
  { id: 'a4-landscape', label: 'A4 Landscape', category: 'print', width: 1123, height: 794 },
  { id: 'a4-portrait', label: 'A4 Portrait', category: 'print', width: 794, height: 1123 },
  { id: 'us-letter-landscape', label: 'US Letter Landscape', category: 'print', width: 1100, height: 850 },
  { id: 'us-letter-portrait', label: 'US Letter Portrait', category: 'print', width: 850, height: 1100 },
] as const

/** Resolve a size preset by its identifier or return null if not found */
export function findPreset(id: string): SizePreset | null {
  return SIZE_PRESETS.find((p) => p.id === id) ?? null
}

/** Match a (width, height) pair against the preset table. Returns the first
 *  exact match or null — used to drive the dropdown selection indicator. */
export function matchPreset(width: number, height: number): SizePreset | null {
  return SIZE_PRESETS.find((p) => p.width === width && p.height === height) ?? null
}

// ---------------------------------------------------------------------------
// Export quality presets
// ---------------------------------------------------------------------------

/** Define supported image export formats as PNG or JPEG */
export type ExportFormat = 'png' | 'jpeg'

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
  name: string
  /** Target pixels-per-document-px for stage.toDataURL. */
  pixelRatio: number
  outputWidth: number | null
  outputHeight: number | null
  /** Whether bleed margins are included in the crop rect. */
  includeBleed: boolean
  format: ExportFormat
}

/** Provide predefined export configurations for various social media and image formats */
export const EXPORT_PRESETS: Record<string, ExportPreset> = {
  'instagram-square': {
    name: 'Instagram square (1080×1080)',
    pixelRatio: 1,
    outputWidth: 1080,
    outputHeight: 1080,
    includeBleed: false,
    format: 'jpeg',
  },
  'instagram-portrait': {
    name: 'Instagram portrait (1080×1350)',
    pixelRatio: 1,
    outputWidth: 1080,
    outputHeight: 1350,
    includeBleed: false,
    format: 'jpeg',
  },
  'twitter-card': {
    name: 'Twitter/X card (1200×675)',
    pixelRatio: 1,
    outputWidth: 1200,
    outputHeight: 675,
    includeBleed: false,
    format: 'jpeg',
  },
  'og-image': {
    name: 'OG image (1200×630)',
    pixelRatio: 1,
    outputWidth: 1200,
    outputHeight: 630,
    includeBleed: false,
    format: 'png',
  },
  'print-a4': {
    name: 'Print A4 (300 dpi)',
    pixelRatio: 3.125,
    outputWidth: null,
    outputHeight: null,
    includeBleed: true,
    format: 'png',
  },
  'screen-2x': {
    name: 'Screen @2×',
    pixelRatio: 2,
    outputWidth: null,
    outputHeight: null,
    includeBleed: false,
    format: 'png',
  },
} as const

// ---------------------------------------------------------------------------
// Crop + scale math (pure, no canvas context)
// ---------------------------------------------------------------------------

/** Define crop rectangle coordinates and dimensions for exporting content within page bounds */
export interface ExportCropRect {
  /** Page-coordinate origin. Negative when bleed extends outside page bounds. */
  x: number
  y: number
  width: number
  height: number
}

/**
 * Crop rectangle in page coordinates for a given page, optionally expanded to
 * include bleed margins. Bleed extends OUTSIDE the page bounds, so the origin
 * goes negative when bleed is included.
 *
 * When `includeBleed` is true but `page.bleed` is null, the page rect is
 * returned unchanged — the caller must not assume symmetric expansion.
 */
export function bleedAwareExportBounds(page: ScenePage, includeBleed: boolean): ExportCropRect {
  if (!includeBleed || page.bleed === null) {
    return { x: 0, y: 0, width: page.width, height: page.height }
  }
  const bleed: PageBleed = page.bleed
  return {
    x: -bleed.left,
    y: -bleed.top,
    width: page.width + bleed.left + bleed.right,
    height: page.height + bleed.top + bleed.bottom,
  }
}

/**
 * Pixel ratio for stage.toDataURL given a crop rect and an export preset.
 *
 * When the preset pins `outputWidth`, the ratio is derived from the crop rect
 * width so the final raster is exactly that many pixels wide. When there is no
 * output pin, the preset's declared `pixelRatio` is returned directly.
 *
 * The crop rect must already account for bleed inclusion before this call.
 */
export function scaleForPreset(preset: ExportPreset, cropRect: ExportCropRect): number {
  if (preset.outputWidth !== null) {
    if (cropRect.width <= 0) {
      throw new Error(`export crop width must be positive, got ${cropRect.width}`)
    }
    return preset.outputWidth / cropRect.width
  }
  return preset.pixelRatio
}

// ---------------------------------------------------------------------------
// Channel-size presets (fixed output resolutions for the export UI)
// ---------------------------------------------------------------------------

/** Define a preset configuration for a channel including its id, label, width, and height */
export interface ChannelPreset {
  id: string
  label: string
  width: number
  height: number
}

/**
 * Fixed output resolution presets for the channel/platform export dialog.
 * Width × height are OUTPUT pixels (the raster the export produces), not page
 * CSS px — they describe the target delivery format, not the canvas layout.
 * The a4_print_2480x3508 preset corresponds to A4 at 300 dpi.
 */
export const CHANNEL_PRESETS: readonly ChannelPreset[] = [
  { id: 'square_1080',        label: 'Square (1080×1080)',               width: 1080, height: 1080 },
  { id: 'portrait_1080x1350', label: 'Portrait (1080×1350)',             width: 1080, height: 1350 },
  { id: 'story_1080x1920',    label: 'Story (1080×1920)',                width: 1080, height: 1920 },
  { id: 'landscape_1200x628', label: 'Landscape (1200×628)',             width: 1200, height: 628  },
  { id: 'wide_1920x1080',     label: 'Wide (1920×1080)',                 width: 1920, height: 1080 },
  { id: 'og_1200x630',        label: 'Open Graph (1200×630)',            width: 1200, height: 630  },
  { id: 'a4_print_2480x3508', label: 'A4 Print (2480×3508 · 300 dpi)',  width: 2480, height: 3508 },
] as const

/** Resolve a valid channel preset identifier from the predefined channel presets array */
export type ChannelPresetId = (typeof CHANNEL_PRESETS)[number]['id']

/** Throws when the id is unknown — callers should only pass ids sourced from
 *  `CHANNEL_PRESETS`. */
export function requireChannelPreset(id: string): ChannelPreset {
  const found = CHANNEL_PRESETS.find((p) => p.id === id)
  if (!found) {
    throw new Error(
      `unknown channel preset "${id}" — valid ids: ${CHANNEL_PRESETS.map((p) => p.id).join(', ')}`,
    )
  }
  return found
}

// ---------------------------------------------------------------------------
// Letterbox scale math (page → channel preset, centered contain)
// ---------------------------------------------------------------------------

/** Define the pixel ratio and horizontal offset for scaling a Konva stage to a channel preset size */
export interface ChannelScaleResult {
  /**
   * Konva stage pixelRatio: the stage logical size stays at page dimensions;
   * the backing canvas renders at `pixelRatio × page` px. Setting Konva's
   * pixelRatio to this value yields an output canvas exactly
   * `channelPreset.width × channelPreset.height` pixels.
   */
  pixelRatio: number
  /**
   * Horizontal letterbox offset in PAGE-coordinate px. Add to the stage x
   * translation so the page is centered horizontally in the output frame.
   * Zero when the page fills the full width after scaling.
   */
  offsetX: number
  /**
   * Vertical letterbox offset in PAGE-coordinate px. Add to the stage y
   * translation. Zero when the page fills the full height.
   */
  offsetY: number
  fit: 'contain'
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
export function scalePageForChannelPreset(
  page: Pick<ScenePage, 'width' | 'height'>,
  channelPreset: ChannelPreset,
): ChannelScaleResult {
  if (page.width <= 0 || page.height <= 0) {
    throw new Error(`page dimensions must be positive; got ${page.width}×${page.height}`)
  }

  const scaleX = channelPreset.width / page.width
  const scaleY = channelPreset.height / page.height
  const pixelRatio = Math.min(scaleX, scaleY)

  const renderedW = page.width * pixelRatio
  const renderedH = page.height * pixelRatio

  // Back-project padding into page coordinates so the Konva offset is in the
  // stage's own coordinate space
  const offsetX = ((channelPreset.width - renderedW) / 2) / pixelRatio
  const offsetY = ((channelPreset.height - renderedH) / 2) / pixelRatio

  return { pixelRatio, offsetX, offsetY, fit: 'contain' }
}

// ---------------------------------------------------------------------------
// Bleed-aware trim bounds (no-arg bleed variant for templates/channel exports)
// ---------------------------------------------------------------------------

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
export function bleedAwareExportRect(page: Pick<ScenePage, 'width' | 'height' | 'bleed'>): Bounds {
  if (page.bleed === null) {
    return { x: 0, y: 0, width: page.width, height: page.height }
  }
  const bleed: PageBleed = page.bleed
  return {
    x: -bleed.left,
    y: -bleed.top,
    width: page.width + bleed.left + bleed.right,
    height: page.height + bleed.top + bleed.bottom,
  }
}
