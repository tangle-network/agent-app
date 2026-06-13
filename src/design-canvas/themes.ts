/**
 * Curated ThemePack catalogue for design-canvas. A ThemePack is a coherent
 * design language — typography, palette, spacing, and doctrine — that drives
 * every color and font decision in an archetype without hardcoding values in
 * the layout itself.
 *
 * Palette contrast invariant: every text role achieves ≥ 4.5:1 against the
 * background(s) it appears on. Computed values are recorded in the test suite;
 * do not adjust hex values without rerunning the contrast tests.
 *
 * Size scale is defined for a 1080 px wide frame. Scale proportionally for
 * other frame widths; do not use the pixel values as absolute measurements.
 */

export interface TypographySpec {
  family: string
  /** CSS font-weight values the family should be loaded with. */
  weights: number[]
  /**
   * Five-step size scale in px at 1080 px frame width:
   * [hero, h1, h2, body, caption]
   */
  sizeScale: [number, number, number, number, number]
}

export interface ThemePalette {
  /** Full-bleed page background. */
  background: string
  /** Card / panel surface that sits on background. */
  surface: string
  /** Primary text — headlines, body copy. */
  textPrimary: string
  /** Secondary text — captions, metadata, supporting lines. */
  textSecondary: string
  /** Brand accent — CTAs, highlights, rules. */
  accent: string
  /** Text / icon color drawn ON the accent. */
  accentText: string
}

export interface ThemePack {
  id: string
  name: string
  /** One-word design mood: guides preset selection. */
  mood: string
  typography: {
    display: TypographySpec
    body: TypographySpec
  }
  palette: ThemePalette
  /** 8px base unit; used to derive margin / gap rhythm. */
  spacingUnit: 8
  /** Corner-radius vocabulary in px: [small, medium, large, pill]. */
  radii: [number, number, number, number]
  /**
   * Usage doctrine: 3–5 sentences describing intended use cases, tone, and
   * composition rules. Guides archetype authors and agent scaffold prompts.
   */
  doctrine: string
}

// ---------------------------------------------------------------------------
// Theme catalogue
// ---------------------------------------------------------------------------

/**
 * 1. bold-editorial
 * Oversized display type on near-black. Inspired by contemporary magazine
 * editorial — high contrast, confident negative space, accent as punctuation.
 * Verified contrast pairs:
 *   #F5F5F0 / #0A0A0B → 18.10:1   #A8A8A0 / #0A0A0B → 8.27:1
 *   #0A0A0B / #E8FF47 → 17.74:1
 */
export const THEME_BOLD_EDITORIAL: ThemePack = {
  id: 'bold-editorial',
  name: 'Bold Editorial',
  mood: 'editorial',
  typography: {
    display: {
      family: 'Archivo',
      weights: [700, 900],
      sizeScale: [128, 80, 56, 22, 13],
    },
    body: {
      family: 'Manrope',
      weights: [400, 600],
      sizeScale: [128, 80, 56, 22, 13],
    },
  },
  palette: {
    background: '#0A0A0B',
    surface: '#141416',
    textPrimary: '#F5F5F0',
    textSecondary: '#A8A8A0',
    accent: '#E8FF47',
    accentText: '#0A0A0B',
  },
  spacingUnit: 8,
  radii: [2, 4, 8, 999],
  doctrine: `Reserve this theme for content that needs to command attention at a glance: launch announcements, thought-leadership covers, and hero moments. The near-black field amplifies the oversized Archivo display weight — keep headline count to one or two words per line. The acid-yellow accent is structural punctuation only; one accent element per layout maximum. Body copy uses Manrope at 22 px with generous line-height; anything smaller should use textSecondary. Avoid decorative borders or gradients — the contrast between field and type IS the composition.`,
}

/**
 * 2. clean-saas
 * Light, restrained, and optimistic. The workhorse of SaaS product marketing —
 * Inter everywhere, a single blue action accent, generous whitespace.
 * Verified contrast pairs:
 *   #111118 / #FAFAFA → 18.01:1   #6B7280 / #FAFAFA → 4.63:1
 *   #FFFFFF / #2563EB → 5.17:1
 */
export const THEME_CLEAN_SAAS: ThemePack = {
  id: 'clean-saas',
  name: 'Clean SaaS',
  mood: 'restrained',
  typography: {
    display: {
      family: 'Inter',
      weights: [600, 700],
      sizeScale: [96, 64, 48, 20, 12],
    },
    body: {
      family: 'Inter',
      weights: [400, 500],
      sizeScale: [96, 64, 48, 20, 12],
    },
  },
  palette: {
    background: '#FAFAFA',
    surface: '#FFFFFF',
    textPrimary: '#111118',
    textSecondary: '#6B7280',
    accent: '#2563EB',
    accentText: '#FFFFFF',
  },
  spacingUnit: 8,
  radii: [4, 8, 12, 999],
  doctrine: `This theme is optimised for product screenshots, feature callouts, and email headers where clarity beats character. Single-weight Inter at medium tracking keeps text scannable across thumbnail sizes. Use surface as a card layer above background to create subtle depth without shadows. The blue accent maps to one primary CTA per layout; avoid tinting backgrounds or using accent as a text fill anywhere. Margins should be a minimum of 10% of frame width — the whitespace is doing active work.`,
}

/**
 * 3. brutalist-mono
 * Raw grid, maximum contrast, monospace body. Appropriate for developer
 * tooling, fintech, and brands that explicitly reject cosmetic polish.
 * Verified contrast pairs:
 *   #0D0D0D / #F2F0EB → 17.07:1   #3D3D3D / #F2F0EB → 9.54:1
 *   #F2F0EB / #0D0D0D → 17.07:1
 */
export const THEME_BRUTALIST_MONO: ThemePack = {
  id: 'brutalist-mono',
  name: 'Brutalist Mono',
  mood: 'brutalist',
  typography: {
    display: {
      family: 'Space Grotesk',
      weights: [700],
      sizeScale: [112, 72, 52, 20, 12],
    },
    body: {
      family: 'IBM Plex Sans',
      weights: [400, 500],
      sizeScale: [112, 72, 52, 20, 12],
    },
  },
  palette: {
    background: '#F2F0EB',
    surface: '#FFFFFF',
    textPrimary: '#0D0D0D',
    textSecondary: '#3D3D3D',
    accent: '#0D0D0D',
    accentText: '#F2F0EB',
  },
  spacingUnit: 8,
  radii: [0, 0, 0, 0],
  doctrine: `Radii are zero — every corner is hard. Use thick 2–3 px rules instead of whitespace to separate sections. Space Grotesk at heavy weight for all display copy; IBM Plex Sans carries body. Accent fills are pure black; the accent block IS the CTA — invert it to get a filled button. This theme reads best with compressed line-height (1.1–1.2×) on display and normal (1.5×) on body. Avoid any photography — illustration or diagrams only; or use black-and-white photography with a high-contrast filter.`,
}

/**
 * 4. warm-premium
 * Serif display with warm off-white ground. For luxury, food, hospitality,
 * or professional services brands that lead with credibility over energy.
 * Verified contrast pairs:
 *   #1C1410 / #FAF7F2 → 16.99:1   #6B5E52 / #FAF7F2 → 5.87:1
 *   #FAF7F2 / #7C3A1E → 7.92:1
 */
export const THEME_WARM_PREMIUM: ThemePack = {
  id: 'warm-premium',
  name: 'Warm Premium',
  mood: 'premium',
  typography: {
    display: {
      family: 'Fraunces',
      weights: [300, 700],
      sizeScale: [104, 72, 48, 20, 12],
    },
    body: {
      family: 'DM Sans',
      weights: [400, 500],
      sizeScale: [104, 72, 48, 20, 12],
    },
  },
  palette: {
    background: '#FAF7F2',
    surface: '#FFFFFF',
    textPrimary: '#1C1410',
    textSecondary: '#6B5E52',
    accent: '#7C3A1E',
    accentText: '#FAF7F2',
  },
  spacingUnit: 8,
  radii: [2, 4, 8, 32],
  doctrine: `Fraunces at 300 weight for oversized display — the optical size axis makes it look elegant at any scale; use the 700 weight only for very short emphasis phrases (≤5 words). Pair with DM Sans at 400 for body; never use serif in body roles on small text. The warm terracotta accent belongs on rule lines, CTA backgrounds, and pull-quote punctuation — not inline with body copy. Photography should feel editorial and warm-toned; desaturated or cold images undercut the theme's credibility signal. Margins ≥ 12% frame width.`,
}

/**
 * 5. electric-gradient
 * Dark violet field with a single mint-green luminous accent. One gradient
 * used structurally (the accent glow), not decoratively.
 * Verified contrast pairs:
 *   #EEEEFF / #0D0D1A → 16.80:1   #9090C0 / #0D0D1A → 6.37:1
 *   #0D0D1A / #7EFACC → 15.08:1
 */
export const THEME_ELECTRIC_GRADIENT: ThemePack = {
  id: 'electric-gradient',
  name: 'Electric Gradient',
  mood: 'electric',
  typography: {
    display: {
      family: 'Sora',
      weights: [600, 800],
      sizeScale: [108, 72, 52, 20, 12],
    },
    body: {
      family: 'DM Sans',
      weights: [400, 500],
      sizeScale: [108, 72, 52, 20, 12],
    },
  },
  palette: {
    background: '#0D0D1A',
    surface: '#16162A',
    textPrimary: '#EEEEFF',
    textSecondary: '#9090C0',
    accent: '#7EFACC',
    accentText: '#0D0D1A',
  },
  spacingUnit: 8,
  radii: [4, 8, 16, 999],
  doctrine: `The accent (#7EFACC) is a luminous mint — use it as a fill for one primary CTA rect per layout and as a text accent on single words in the headline. Never spread it across more than 15% of total frame area or it loses its energy. Sora at ExtraBold for display; the condensed optical weight holds at large sizes. Background is not pitch black — the slight blue cast keeps dark content from feeling dead on screen. When using image slots, desaturate originals slightly and blend them into the background field so photography doesn't fight the palette.`,
}

/**
 * 6. print-classic
 * Near-white field, ink-dark text, terracotta accent. Modelled on editorial
 * print design — long-form readability, no digital-only tricks.
 * Verified contrast pairs:
 *   #1A1A18 / #FFFEF9 → 17.26:1   #5C5C50 / #FFFEF9 → 6.70:1
 *   #FFFEF9 / #B5541A → 4.90:1
 */
export const THEME_PRINT_CLASSIC: ThemePack = {
  id: 'print-classic',
  name: 'Print Classic',
  mood: 'print',
  typography: {
    display: {
      family: 'Fraunces',
      weights: [400, 700],
      sizeScale: [96, 64, 44, 19, 12],
    },
    body: {
      family: 'IBM Plex Sans',
      weights: [400, 500],
      sizeScale: [96, 64, 44, 19, 12],
    },
  },
  palette: {
    background: '#FFFEF9',
    surface: '#F5F4EE',
    textPrimary: '#1A1A18',
    textSecondary: '#5C5C50',
    accent: '#B5541A',
    accentText: '#FFFEF9',
  },
  spacingUnit: 8,
  radii: [2, 4, 6, 24],
  doctrine: `Modelled on newspaper and editorial magazine grids — tight column structure, high x-height body type, minimal ornament. Fraunces for all display; IBM Plex Sans for body and captions. The terracotta accent functions as a running head color, section rule, or byline accent — never as a button fill (this is print language, not UI). Body text should run at 19 px / 1.6 line-height for maximum readability in portrait layouts. Avoid heavy image overlays — photography should sit in a bounded frame with adequate white breathing room, not bleed full-page behind copy.`,
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const THEME_PACKS: readonly ThemePack[] = [
  THEME_BOLD_EDITORIAL,
  THEME_CLEAN_SAAS,
  THEME_BRUTALIST_MONO,
  THEME_WARM_PREMIUM,
  THEME_ELECTRIC_GRADIENT,
  THEME_PRINT_CLASSIC,
] as const

export type ThemePackId = (typeof THEME_PACKS)[number]['id']

/** Throws when the id is unknown — callers must pass ids sourced from THEME_PACKS. */
export function requireThemePack(id: string): ThemePack {
  const found = THEME_PACKS.find((t) => t.id === id)
  if (!found) {
    throw new Error(
      `unknown theme id "${id}" — valid ids: ${THEME_PACKS.map((t) => t.id).join(', ')}`,
    )
  }
  return found
}
