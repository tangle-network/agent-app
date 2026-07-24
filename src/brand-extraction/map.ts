/**
 * Pure mapping helpers from an extracted BrandKit onto consumable shapes.
 *
 * Extraction yields ranked candidate lists; products need decided roles
 * (background vs accent, display vs body). These helpers make the obvious,
 * defensible default choice and expose the reasoning so a confirmation UI can
 * show "we picked X — change it?". They NEVER invent a value: when a role can't
 * be filled from the kit, it is omitted, and the caller decides the fallback.
 */

import type { BrandColor, BrandFont, BrandKit } from './types'

/** Relative luminance (0..1) of an #rrggbb(aa) hex — for light/dark sorting. */
export function luminance(hex: string): number {
  const h = hex.replace('#', '').slice(0, 6)
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function isGreyish(hex: string): boolean {
  const h = hex.replace('#', '').slice(0, 6)
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return max - min < 18
}

/** Define a color palette with background, surface, text, and accent colors for UI elements */
export interface DecidedPalette {
  /** Lightest neutral — page background. */
  background?: string
  /** A raised neutral one step from background. */
  surface?: string
  /** Darkest readable color — primary text. */
  textPrimary?: string
  /** Mid-tone neutral — secondary text. */
  textSecondary?: string
  /** Most saturated / popular brand color — accent. */
  accent?: string
  /** Readable text color to sit on the accent (black or white by contrast). */
  accentText?: string
}

/**
 * Assign palette roles from the ranked colors. Heuristic, not authoritative —
 * a confirmation step should let the user correct it. Roles only appear when
 * the kit actually contained a color that fits.
 */
export function decidePalette(palette: BrandColor[]): DecidedPalette {
  if (palette.length === 0) return {}
  const hexes = palette.map((c) => c.hex)
  const greys = hexes.filter(isGreyish).sort((a, b) => luminance(b) - luminance(a))
  const colored = hexes.filter((h) => !isGreyish(h))

  // Accent: the top-ranked non-grey (token-first, popularity-first) color.
  const accent = colored[0]
  // Background: lightest grey (or lightest overall when no greys).
  const sortedLight = [...hexes].sort((a, b) => luminance(b) - luminance(a))
  const background = greys[0] ?? sortedLight[0]
  // Surface: next grey under background, else second-lightest.
  const surface = greys[1] ?? sortedLight.find((h) => h !== background)
  // Text primary: darkest color overall.
  const textPrimary = [...hexes].sort((a, b) => luminance(a) - luminance(b))[0]
  // Text secondary: a mid-luminance grey distinct from primary/background.
  const textSecondary = greys.find((h) => h !== background && h !== surface && h !== textPrimary)

  const result: DecidedPalette = {}
  if (background) result.background = background
  if (surface) result.surface = surface
  if (textPrimary) result.textPrimary = textPrimary
  if (textSecondary) result.textSecondary = textSecondary
  if (accent) {
    result.accent = accent
    result.accentText = luminance(accent) > 0.45 ? '#000000' : '#ffffff'
  }
  return result
}

/** Define font selections for display and body text with optional BrandFont properties */
export interface DecidedFonts {
  display?: BrandFont
  body?: BrandFont
}

/** Pick a display and body font from the ranked list. When only one usable
 *  font exists it fills both roles — a single-typeface brand is valid. */
export function decideFonts(fonts: BrandFont[]): DecidedFonts {
  if (fonts.length === 0) return {}
  const display = fonts.find((f) => f.role === 'display') ?? fonts[0]
  const body = fonts.find((f) => f.role === 'body') ?? fonts.find((f) => f !== display) ?? display
  return { display, body }
}

/** Everything a confirmation step needs from a kit, with roles decided. */
export interface DecidedBrandKit {
  name?: string
  description?: string
  sourceUrl: string
  palette: DecidedPalette
  fonts: DecidedFonts
  /** Best logo URL, when any candidate was found. */
  primaryLogoUrl?: string
  /** All logo URLs, ranked. */
  logoUrls: string[]
  /** Prominent image URLs, ranked. */
  imageUrls: string[]
  extractedFrom: string[]
}

/** Collapse a raw BrandKit into decided roles — the shape a product persists. */
export function decideBrandKit(kit: BrandKit): DecidedBrandKit {
  const palette = decidePalette(kit.palette)
  const fonts = decideFonts(kit.fonts)
  const logoUrls = kit.logos.map((l) => l.url)
  const result: DecidedBrandKit = {
    sourceUrl: kit.sourceUrl,
    palette,
    fonts,
    logoUrls,
    imageUrls: kit.images.map((i) => i.url),
    extractedFrom: kit.extractedFrom,
  }
  if (kit.name) result.name = kit.name
  if (kit.description) result.description = kit.description
  if (logoUrls[0]) result.primaryLogoUrl = logoUrls[0]
  return result
}
