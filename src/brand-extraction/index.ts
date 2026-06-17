/**
 * @tangle-network/agent-app/brand-extraction
 *
 * Reusable brand-kit extraction: given a website URL (or raw HTML), produce a
 * typed BrandKit — logos, palette, fonts, images — with a typed outcome and
 * graceful degradation. Edge-safe (regex parsing, no DOM dependency). Pure
 * mechanism: no persistence, no rendering. Consumers (gtm, creative) map the
 * decided kit onto their own durable brand store via the `map` helpers.
 */

export * from './types'
export { extractBrandKit, parseBrandKit, normalizeSiteUrl, normalizeColor } from './extract'
export {
  decideBrandKit,
  decidePalette,
  decideFonts,
  luminance,
} from './map'
export type { DecidedBrandKit, DecidedPalette, DecidedFonts } from './map'
