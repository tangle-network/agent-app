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
  warning: string
  /** Full CSS color (not a triple) — the canvas/scene backdrop. */
  canvasBackdrop: string
}

export const lightTheme: AgentAppTheme = {
  background: '0 0% 100%',
  foreground: '222 47% 11%',
  card: '0 0% 100%',
  cardForeground: '222 47% 11%',
  popover: '0 0% 100%',
  popoverForeground: '222 47% 11%',
  primary: '221 83% 53%',
  primaryForeground: '0 0% 100%',
  secondary: '210 40% 96%',
  secondaryForeground: '222 47% 30%',
  muted: '210 40% 96%',
  mutedForeground: '215 16% 47%',
  accent: '210 40% 96%',
  accentForeground: '222 47% 11%',
  destructive: '0 72% 51%',
  destructiveForeground: '0 0% 100%',
  border: '214 32% 91%',
  input: '214 32% 91%',
  ring: '221 83% 53%',
  success: '142 71% 45%',
  warning: '38 92% 50%',
  canvasBackdrop: 'hsl(220 13% 91%)',
}

export const darkTheme: AgentAppTheme = {
  background: '222 47% 7%',
  foreground: '210 40% 98%',
  card: '222 47% 11%',
  cardForeground: '210 40% 98%',
  popover: '222 47% 11%',
  popoverForeground: '210 40% 98%',
  primary: '217 91% 60%',
  primaryForeground: '222 47% 11%',
  secondary: '217 33% 17%',
  secondaryForeground: '210 40% 90%',
  muted: '217 33% 17%',
  mutedForeground: '215 20% 65%',
  accent: '217 33% 17%',
  accentForeground: '210 40% 98%',
  destructive: '0 63% 50%',
  destructiveForeground: '210 40% 98%',
  border: '217 33% 20%',
  input: '217 33% 20%',
  ring: '217 91% 60%',
  success: '142 71% 45%',
  warning: '38 92% 50%',
  canvasBackdrop: 'hsl(0 0% 10%)',
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
    '--warning': theme.warning,
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
