/**
 * Typed mirror of tokens.css for runtime/JS theming. The canonical source is
 * tokens.css (`import '@tangle-network/agent-app/styles'`); this module is for
 * apps that compute theme variables in JS, or read color values where CSS
 * custom properties cannot reach — notably Konva canvas render code, which
 * paints to a bitmap and cannot resolve `var(--…)`.
 *
 * Values are shadcn-style HSL channel triples ("H S% L%"); wrap with `color()`.
 *
 * The neutral triples are the RESOLVED form of tokens.css's `--neutral-*` ramp
 * (that file states them as `var(--neutral-NN-hsl)`; JS has no cascade to
 * resolve through, so they are inlined here). `tests/theme/tokens-contract.test.ts`
 * resolves the CSS one level and fails if this mirror has drifted.
 */

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
export const lightTheme: AgentAppTheme = {
  background: '233.2 14.8% 93.4%',
  foreground: '234.9 28.5% 6.4%',
  card: '0 0% 100%',
  cardForeground: '234.9 28.5% 6.4%',
  popover: '0 0% 100%',
  popoverForeground: '234.9 28.5% 6.4%',
  primary: '245 62% 57%',
  primaryForeground: '0 0% 100%',
  secondary: '233.2 19.9% 95.9%',
  secondaryForeground: '234.2 17.6% 11.3%',
  muted: '233.2 19.9% 95.9%',
  mutedForeground: '239.7 1.3% 38.2%',
  accent: '233.2 19.9% 95.9%',
  accentForeground: '234.2 17.6% 11.3%',
  destructive: '0 72% 41%',
  destructiveForeground: '0 0% 100%',
  border: '233.1 6.8% 81.4%',
  input: '233.1 6.8% 81.4%',
  ring: '245 62% 57%',
  success: '160 84% 26%',
  successForeground: '0 0% 100%',
  warning: '41 96% 38%',
  warningForeground: '38 92% 12%',
  warningStrong: '41 96% 27%',
  canvasBackdrop: 'hsl(233.1 12.5% 90.9%)',
  borderSoft: 'color-mix(in oklch, hsl(var(--border)) 40%, transparent)',
  cardEdge: 'color-mix(in oklch, hsl(var(--border)) 60%, transparent)',
  canvasRender: {
    grid: '#c0c0c0',
    snapGrid: '#a0a0a0',
    snapGuide: '#3b82f6',
    snapPage: '#f59e0b',
    snapElement: '#f43f5e',
    selectionStroke: '#00a1ff',
    selectionAnchorFill: '#ffffff',
    placeholderFill: '#1f2937',
    placeholderStroke: '#374151',
    brokenFill: '#e5e7eb',
    brokenStroke: '#9ca3af',
  },
}

/** Define a dark color scheme for the Agent app interface with specific background and foreground hues */
export const darkTheme: AgentAppTheme = {
  background: '234.5 21.2% 9%',
  foreground: '233.2 14.8% 93.4%',
  card: '233.8 12.9% 15.4%',
  cardForeground: '233.2 14.8% 93.4%',
  popover: '233.6 9.3% 21.2%',
  popoverForeground: '233.2 14.8% 93.4%',
  primary: '239 84% 74%',
  // Inverted, not copied from light: white on this fill measures 3.02:1.
  primaryForeground: '234.9 28.5% 6.4%',
  secondary: '233.7 10.7% 19.3%',
  secondaryForeground: '233.2 14.8% 93.4%',
  muted: '233.7 10.7% 19.3%',
  mutedForeground: '239.6 1.5% 62.5%',
  accent: '233.7 10.7% 19.3%',
  accentForeground: '233.2 14.8% 93.4%',
  destructive: '348 90% 68%',
  destructiveForeground: '234.2 17.6% 11.3%',
  border: '233.4 7% 25.6%',
  input: '234.2 17.6% 11.3%',
  ring: '239 84% 74%',
  success: '160 70% 52%',
  successForeground: '160 84% 10%',
  warning: '40 94% 56%',
  warningForeground: '38 92% 12%',
  warningStrong: '40 94% 56%',
  canvasBackdrop: 'hsl(234.9 28.5% 6.4%)',
  // The lifted border (L 0.365) leaves room to soften: 60% still reads 1.265
  // on the card, where the old border at full strength read 1.158.
  borderSoft: 'color-mix(in oklch, hsl(var(--border)) 60%, transparent)',
  cardEdge: 'color-mix(in oklch, hsl(var(--border)) 80%, transparent)',
  canvasRender: {
    grid: '#3a3a3a',
    snapGrid: '#5a5a5a',
    snapGuide: '#3b82f6',
    snapPage: '#f59e0b',
    snapElement: '#f43f5e',
    selectionStroke: '#00a1ff',
    selectionAnchorFill: '#e5e7eb',
    placeholderFill: '#2a2f3a',
    placeholderStroke: '#3f4654',
    brokenFill: '#262b33',
    brokenStroke: '#4b5563',
  },
}

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
    '--bg-input': `hsl(${theme.card})`,
    '--text-primary': `hsl(${theme.foreground})`,
    '--text-secondary': `hsl(${theme.secondaryForeground})`,
    '--text-muted': `hsl(${theme.mutedForeground})`,
    '--text-danger': `hsl(${theme.destructive})`,
    '--border-default': `hsl(${theme.border})`,
    '--brand-primary': `hsl(${theme.primary})`,
    '--editor-selection-background': `hsl(${theme.primary})`,
    '--editor-selection-foreground': `hsl(${theme.background})`,
    '--canvas-backdrop': theme.canvasBackdrop,
    // Full strength is the safe default: an unset tier can under-draw an edge,
    // never erase one.
    '--border-soft': theme.borderSoft ?? `hsl(${theme.border})`,
    '--card-edge': theme.cardEdge ?? `hsl(${theme.border})`,
  }
}
