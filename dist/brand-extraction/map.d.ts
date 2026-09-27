/**
 * Pure mapping helpers from an extracted BrandKit onto consumable shapes.
 *
 * Extraction yields ranked candidate lists; products need decided roles
 * (background vs accent, display vs body). These helpers make the obvious,
 * defensible default choice and expose the reasoning so a confirmation UI can
 * show "we picked X — change it?". They NEVER invent a value: when a role can't
 * be filled from the kit, it is omitted, and the caller decides the fallback.
 */
import type { BrandColor, BrandFont, BrandKit } from './types';
/** Relative luminance (0..1) of an #rrggbb(aa) hex — for light/dark sorting. */
export declare function luminance(hex: string): number;
/** Define a color palette with background, surface, text, and accent colors for UI elements */
export interface DecidedPalette {
    /** Lightest neutral — page background. */
    background?: string;
    /** A raised neutral one step from background. */
    surface?: string;
    /** Darkest readable color — primary text. */
    textPrimary?: string;
    /** Mid-tone neutral — secondary text. */
    textSecondary?: string;
    /** Most saturated / popular brand color — accent. */
    accent?: string;
    /** Readable text color to sit on the accent (black or white by contrast). */
    accentText?: string;
}
/**
 * Assign palette roles from the ranked colors. Heuristic, not authoritative —
 * a confirmation step should let the user correct it. Roles only appear when
 * the kit actually contained a color that fits.
 */
export declare function decidePalette(palette: BrandColor[]): DecidedPalette;
/** Define font selections for display and body text with optional BrandFont properties */
export interface DecidedFonts {
    display?: BrandFont;
    body?: BrandFont;
}
/** Pick a display and body font from the ranked list. When only one usable
 *  font exists it fills both roles — a single-typeface brand is valid. */
export declare function decideFonts(fonts: BrandFont[]): DecidedFonts;
/** Everything a confirmation step needs from a kit, with roles decided. */
export interface DecidedBrandKit {
    name?: string;
    description?: string;
    sourceUrl: string;
    palette: DecidedPalette;
    fonts: DecidedFonts;
    /** Best logo URL, when any candidate was found. */
    primaryLogoUrl?: string;
    /** All logo URLs, ranked. */
    logoUrls: string[];
    /** Prominent image URLs, ranked. */
    imageUrls: string[];
    extractedFrom: string[];
}
/** Collapse a raw BrandKit into decided roles — the shape a product persists. */
export declare function decideBrandKit(kit: BrandKit): DecidedBrandKit;
