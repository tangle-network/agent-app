/**
 * Brand-kit extraction engine.
 *
 * Given a website URL (or raw HTML), parse the page and pull a typed BrandKit:
 * logo candidates, color palette, fonts, and prominent images. Parsing is
 * regex-based on purpose — this runs on Cloudflare Workers and other edge
 * runtimes where DOM libraries (jsdom/cheerio) are unavailable, and the page
 * structures we read (link tags, meta tags, CSS custom properties, font-family
 * declarations) are flat enough that a DOM buys nothing.
 *
 * Degrades gracefully: a missing favicon, no CSS tokens, or an image-only page
 * each narrow the kit rather than failing it. The ONLY hard failures are a bad
 * input (no html and no fetch) and a fetch error — both returned as a typed
 * `{ succeeded: false }` outcome so callers never mistake an empty kit for a
 * real one.
 */
import type { BrandExtractionResult, BrandKit, ExtractBrandKitOptions } from './types';
/** Normalize a user-supplied site URL: add https:// when scheme-less, validate. */
export declare function normalizeSiteUrl(raw: string): string | null;
/** Normalize any CSS color literal to #rrggbb / #rrggbbaa hex, or null. */
export declare function normalizeColor(raw: string): string | null;
/** Parse already-fetched HTML into a BrandKit. Pure — no network. Exposed so
 *  callers that hold the HTML (or want to combine multiple pages) can reuse the
 *  parsing without re-fetching. */
export declare function parseBrandKit(html: string, sourceUrl: string, maxPerList?: number): BrandKit;
/**
 * Fetch a website (or use supplied HTML) and extract its BrandKit.
 *
 * Returns a typed outcome — callers MUST check `succeeded`. A fetch failure or
 * empty input is a real, surfaced error, never an empty kit masquerading as a
 * result. Parsing itself never throws: a malformed page yields a sparse kit
 * with warnings, which is information, not failure.
 */
export declare function extractBrandKit(url: string, options?: ExtractBrandKitOptions): Promise<BrandExtractionResult>;
