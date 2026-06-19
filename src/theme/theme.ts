/**
 * Typed mirror of tokens.css for runtime/JS theming. The canonical source is
 * tokens.css (`import '@tangle-network/agent-app/styles'`); this module is for
 * apps that compute theme variables in JS, or read color values where CSS
 * custom properties cannot reach — notably Konva canvas render code, which
 * paints to a bitmap and cannot resolve `var(--…)`.
 *
 * Values are shadcn-style HSL channel triples ("H S% L%"); wrap with `color()`.
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
  /** Full CSS color (not a triple) — the canvas/scene backdrop. */
  canvasBackdrop: string
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

export const lightTheme: AgentAppTheme = {
  background: '0 0% 100%',
  foreground: '0 0% 5%',
  card: '240 7% 97%',
  cardForeground: '0 0% 5%',
  popover: '0 0% 100%',
  popoverForeground: '0 0% 5%',
  primary: '245 62% 57%',
  primaryForeground: '0 0% 100%',
  secondary: '240 6% 93%',
  secondaryForeground: '0 0% 10%',
  muted: '240 6% 93%',
  mutedForeground: '240 5% 38%',
  accent: '240 6% 93%',
  accentForeground: '0 0% 10%',
  destructive: '0 72% 41%',
  destructiveForeground: '0 0% 100%',
  border: '240 6% 89%',
  input: '240 6% 89%',
  ring: '245 62% 57%',
  success: '160 84% 26%',
  successForeground: '0 0% 100%',
  warning: '41 96% 38%',
  warningForeground: '38 92% 12%',
  canvasBackdrop: 'hsl(240 7% 90%)',
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

export const darkTheme: AgentAppTheme = {
  background: '240 8% 5%',
  foreground: '240 6% 93%',
  card: '240 5% 8%',
  cardForeground: '240 6% 93%',
  popover: '240 4% 13%',
  popoverForeground: '240 6% 93%',
  primary: '239 84% 74%',
  primaryForeground: '0 0% 100%',
  secondary: '240 5% 11%',
  secondaryForeground: '240 6% 93%',
  muted: '240 5% 11%',
  mutedForeground: '240 4% 62%',
  accent: '240 5% 11%',
  accentForeground: '240 6% 93%',
  destructive: '348 90% 68%',
  destructiveForeground: '0 0% 12%',
  border: '240 3% 13%',
  input: '240 5% 11%',
  ring: '239 84% 74%',
  success: '160 70% 52%',
  successForeground: '160 84% 10%',
  warning: '40 94% 56%',
  warningForeground: '38 92% 12%',
  canvasBackdrop: 'hsl(240 8% 5%)',
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

/** Wrap a channel triple in `hsl()`; pass through values already in a color form. */
export function themeColor(value: string): string {
  return value.startsWith('hsl') || value.startsWith('#') || value.startsWith('rgb')
    ? value
    : `hsl(${value})`
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
    '--bg-input': `hsl(${theme.card})`,
    '--text-primary': `hsl(${theme.foreground})`,
    '--text-secondary': `hsl(${theme.secondaryForeground})`,
    '--text-muted': `hsl(${theme.mutedForeground})`,
    '--text-danger': `hsl(${theme.destructive})`,
    '--border-default': `hsl(${theme.border})`,
    '--brand-primary': `hsl(${theme.primary})`,
    '--canvas-backdrop': theme.canvasBackdrop,
  }
}
