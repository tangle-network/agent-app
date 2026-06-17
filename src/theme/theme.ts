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
  foreground: '222 47% 11%',
  card: '0 0% 100%',
  cardForeground: '222 47% 11%',
  popover: '0 0% 100%',
  popoverForeground: '222 47% 11%',
  primary: '221 83% 47%',
  primaryForeground: '0 0% 100%',
  secondary: '210 40% 96%',
  secondaryForeground: '222 47% 30%',
  muted: '210 40% 96%',
  mutedForeground: '215 16% 44%',
  accent: '210 40% 96%',
  accentForeground: '222 47% 11%',
  destructive: '0 72% 45%',
  destructiveForeground: '0 0% 100%',
  border: '214 32% 91%',
  input: '214 32% 91%',
  ring: '221 83% 53%',
  success: '142 72% 29%',
  successForeground: '0 0% 100%',
  warning: '38 92% 32%',
  warningForeground: '38 92% 12%',
  canvasBackdrop: 'hsl(220 13% 91%)',
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
  background: '222 47% 7%',
  foreground: '210 40% 98%',
  card: '222 47% 11%',
  cardForeground: '210 40% 98%',
  popover: '222 47% 11%',
  popoverForeground: '210 40% 98%',
  primary: '217 91% 72%',
  primaryForeground: '222 47% 11%',
  secondary: '217 33% 17%',
  secondaryForeground: '210 40% 90%',
  muted: '217 33% 17%',
  mutedForeground: '215 20% 65%',
  accent: '217 33% 17%',
  accentForeground: '210 40% 98%',
  destructive: '0 78% 67%',
  destructiveForeground: '0 0% 12%',
  border: '217 33% 20%',
  input: '217 33% 20%',
  ring: '217 91% 60%',
  success: '142 60% 50%',
  successForeground: '142 80% 12%',
  warning: '38 95% 58%',
  warningForeground: '38 92% 12%',
  canvasBackdrop: 'hsl(0 0% 10%)',
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
