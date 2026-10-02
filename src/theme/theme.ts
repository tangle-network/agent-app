/** Brand-derived HSL compatibility and bitmap snapshots. Regenerate with src/theme/build.mjs; never author a second palette here. */
import { brandThemes } from './brand.generated'

export interface AgentAppTheme {
  background: string
  foreground: string
  card: string
  cardForeground: string
  popover: string
  popoverForeground: string
  primary: string
  primaryForeground: string
  secondary: string
  secondaryForeground: string
  muted: string
  mutedForeground: string
  accent: string
  accentForeground: string
  destructive: string
  destructiveForeground: string
  border: string
  input: string
  /** Full field fill, distinct from the input border. Optional for existing custom themes. */
  inputFill?: string
  ring: string
  success: string
  successForeground: string
  warning: string
  warningForeground: string
  /**
   * Warning as TEXT on a warning-TINTED surface, as a channel triple. Optional
   * so a consumer's existing `AgentAppTheme` literal still type-checks;
   * {@link themeToCssVars} falls back to `warningForeground`, which is what the
   * surface used before this token existed.
   */
  warningStrong?: string
  /** Full CSS color (not a triple) — the canvas/scene backdrop. */
  canvasBackdrop: string
  /**
   * Border tiers as FULL CSS colors (they are `color-mix()` results, not
   * triples). Optional so a consumer's existing `AgentAppTheme` literal still
   * type-checks; {@link themeToCssVars} falls back to full-strength
   * `hsl(var(--border))`, which can never erase an edge.
   */
  borderSoft?: string
  /** @see borderSoft */
  cardEdge?: string
  /** Konva render palette — full hex colors the bitmap canvas paints with
   *  (it cannot resolve `var(--…)`). NOT emitted by themeToCssVars. */
  canvasRender: CanvasRenderPalette
}

/**
 * Colors the Konva design-canvas paints directly. Konva renders to a bitmap
 * and cannot read CSS custom properties, so these are full hex strings sourced
 * from the active theme and threaded through the canvas components.
 */
export interface CanvasRenderPalette {
  /** Grid line color (GridLayer). */
  grid: string
  /** Grid-snap guide line (SnapGuidesOverlay, kind 'grid'). */
  snapGrid: string
  /** Saved ruler-guide snap line (kind 'guide'). */
  snapGuide: string
  /** Page edge/center snap line (kinds 'page-edge'/'page-center'). */
  snapPage: string
  /** Element edge/center snap line (kinds 'element-edge'/'element-center'). */
  snapElement: string
  /** Transformer border + anchor stroke (SelectionLayer). */
  selectionStroke: string
  /** Transformer anchor fill (SelectionLayer). */
  selectionAnchorFill: string
  /** Video placeholder fill (ElementNode VideoNode). */
  placeholderFill: string
  /** Video placeholder stroke (ElementNode VideoNode). */
  placeholderStroke: string
  /** Broken/loading image placeholder fill (ElementNode ImageNode). */
  brokenFill: string
  /** Broken/loading image placeholder stroke (ElementNode ImageNode). */
  brokenStroke: string
}

/** Define a light color theme with specific background, foreground, and accent color values */
export const lightTheme: AgentAppTheme = brandThemes.light

/** Canonical Brand dark values projected for legacy JS and bitmap callers. */
export const darkTheme: AgentAppTheme = brandThemes.dark

/**
 * Wrap a channel triple in `hsl()`; pass through values already in a color form.
 * `oklch(…)` / `oklab(…)` / `color-mix(…)` are recognised because the ramp is
 * authored in oklch and the border tiers are colour mixes — wrapping either in
 * `hsl()` yields an invalid colour that paints as nothing.
 */
export function themeColor(value: string): string {
  return /^(hsl|rgb|oklch|oklab|lch|lab|color|color-mix|#)/.test(value) ? value : `hsl(${value})`
}

/**
 * Map a theme to the full CSS-variable set (shadcn triples + canvas/sequences
 * aliases + canvas surface). Apply at runtime to scope a theme without loading
 * tokens.css: `Object.assign(el.style, themeToCssVars(darkTheme))`.
 */
export function themeToCssVars(theme: AgentAppTheme): Record<string, string> {
  return {
    '--background': theme.background,
    '--foreground': theme.foreground,
    '--card': theme.card,
    '--card-foreground': theme.cardForeground,
    '--popover': theme.popover,
    '--popover-foreground': theme.popoverForeground,
    '--primary': theme.primary,
    '--primary-foreground': theme.primaryForeground,
    '--secondary': theme.secondary,
    '--secondary-foreground': theme.secondaryForeground,
    '--muted': theme.muted,
    '--muted-foreground': theme.mutedForeground,
    '--accent': theme.accent,
    '--accent-foreground': theme.accentForeground,
    '--destructive': theme.destructive,
    '--destructive-foreground': theme.destructiveForeground,
    '--border': theme.border,
    '--input': theme.input,
    '--ring': theme.ring,
    '--success': theme.success,
    '--success-foreground': theme.successForeground,
    '--warning': theme.warning,
    '--warning-foreground': theme.warningForeground,
    // Falls back to the pairing the tinted surfaces used before this token
    // existed, so an unset value restores the previous look rather than an
    // unthemed one.
    '--warning-strong': theme.warningStrong ?? theme.warningForeground,
    '--bg-input': theme.inputFill ?? `hsl(${theme.card})`,
    '--text-primary': `hsl(${theme.foreground})`,
    '--text-secondary': `hsl(${theme.secondaryForeground})`,
    '--text-muted': `hsl(${theme.mutedForeground})`,
    '--text-danger': `hsl(${theme.destructive})`,
    '--text-warning': `hsl(${theme.warningStrong ?? theme.warningForeground})`,
    '--border-default': `hsl(${theme.border})`,
    '--brand-primary': `hsl(${theme.primary})`,
    '--editor-selection-background': `hsl(${theme.primary})`,
    '--editor-selection-foreground': `hsl(${theme.primaryForeground})`,
    '--canvas-backdrop': theme.canvasBackdrop,
    // Full strength is the safe default: an unset tier can under-draw an edge,
    // never erase one.
    '--border-soft': theme.borderSoft ?? `hsl(${theme.border})`,
    '--card-edge': theme.cardEdge ?? `hsl(${theme.border})`,
  }
}
