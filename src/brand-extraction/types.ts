/**
 * Typed contract for a brand kit extracted from a website (+ optional shared
 * source files). The extractor degrades gracefully: every field is best-effort,
 * absence is represented explicitly (empty arrays, undefined), never faked.
 *
 * A consuming product (gtm, creative) maps this onto its own durable brand
 * store — see the gtm `WorkspaceBrand`. This module owns only extraction; it
 * does NOT persist, render, or judge confidence.
 */

/** A logo / brand-mark candidate discovered on a page. */
export interface BrandLogoCandidate {
  /** Absolute URL to the asset. */
  url: string
  /** Where it came from — drives ranking and lets callers cite provenance. */
  source: 'favicon' | 'apple-touch-icon' | 'og:image' | 'img-logo' | 'svg-inline' | 'manifest'
  /** Higher = more likely the canonical logo. 0..1. */
  confidence: number
  /** Declared width in px when known (from <link sizes> or <img width>). */
  width?: number
  /** Declared height in px when known. */
  height?: number
  /** MIME type when inferable from the extension. */
  mimeType?: string
  /** alt / title text when present — a "logo" alt is a strong signal. */
  alt?: string
}

/** A color extracted from the page, with where it was seen. */
export interface BrandColor {
  /** Normalized 6- or 8-digit `#rrggbb` / `#rrggbbaa` hex (lowercase). */
  hex: string
  /** How many distinct declarations referenced this color (popularity proxy). */
  occurrences: number
  /** True when sourced from a `:root` CSS custom property (highest fidelity). */
  fromToken: boolean
  /** The custom-property name when fromToken (e.g. `--accent`). */
  tokenName?: string
}

/** A font-family discovered in CSS, with role inference. */
export interface BrandFont {
  /** Primary family name, unquoted (e.g. `Inter`, `Playfair Display`). */
  family: string
  /** The full declared stack as written, in order. */
  stack: string[]
  /** Inferred role from the selector the declaration was attached to. */
  role: 'display' | 'body' | 'unknown'
  /** Declaration count — popularity proxy for picking the dominant family. */
  occurrences: number
}

/** A prominent product / hero image candidate (not a logo). */
export interface BrandImage {
  url: string
  source: 'og:image' | 'twitter:image' | 'img-hero' | 'img-content'
  /** alt text when present. */
  alt?: string
  width?: number
  height?: number
}

/**
 * The full extracted kit. The shape every consumer reads. Each list is ranked
 * best-first; empty lists mean "found nothing", never a fabricated default.
 */
export interface BrandKit {
  /** The site the kit was extracted from (normalized, absolute). */
  sourceUrl: string
  /** Best-guess brand / product name from <title>, og:site_name, manifest. */
  name?: string
  /** Tagline / description from meta description or og:description. */
  description?: string
  /** Logo candidates, ranked best-first. */
  logos: BrandLogoCandidate[]
  /** Colors, ranked by token-first then popularity. */
  palette: BrandColor[]
  /** Fonts, ranked display-then-body then popularity. */
  fonts: BrandFont[]
  /** Prominent images (hero / og), ranked best-first. */
  images: BrandImage[]
  /** Absolute URLs / labels the kit was derived from — for provenance. */
  extractedFrom: string[]
}

/**
 * Typed outcome. Callers MUST inspect `succeeded` before reading `kit`.
 * No silent empties: a fetch failure is `succeeded:false` with a real error,
 * NOT an empty BrandKit that downstream code mistakes for "this brand has
 * nothing".
 */
export type BrandExtractionResult =
  | { succeeded: true; kit: BrandKit; warnings: string[] }
  | { succeeded: false; error: string; stage: 'fetch' | 'parse' | 'input' }

/** Fetch boundary, injectable so callers (Workers, Node, tests) supply their
 *  own fetch and so tests can run fully offline against fixture HTML. */
export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
  headers?: { get(name: string): string | null }
}>

export interface ExtractBrandKitOptions {
  /** Raw HTML for the page. When supplied, no network fetch happens — used by
   *  tests and by callers that already hold the HTML. */
  html?: string
  /** Fetch implementation. Required when `html` is omitted. */
  fetchImpl?: FetchLike
  /** Per-request timeout in ms (default 15000). Applied to the page fetch. */
  timeoutMs?: number
  /** Cap on each ranked list (default 12). Keeps payloads bounded. */
  maxPerList?: number
}
