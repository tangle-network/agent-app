// src/theme/theme.ts
var lightTheme = {
  background: "233.2 14.8% 93.4%",
  foreground: "234.9 28.5% 6.4%",
  card: "0 0% 100%",
  cardForeground: "234.9 28.5% 6.4%",
  popover: "0 0% 100%",
  popoverForeground: "234.9 28.5% 6.4%",
  primary: "245 62% 57%",
  primaryForeground: "0 0% 100%",
  secondary: "233.2 19.9% 95.9%",
  secondaryForeground: "234.2 17.6% 11.3%",
  muted: "233.2 19.9% 95.9%",
  mutedForeground: "239.7 1.3% 38.2%",
  accent: "233.2 19.9% 95.9%",
  accentForeground: "234.2 17.6% 11.3%",
  destructive: "0 72% 41%",
  destructiveForeground: "0 0% 100%",
  border: "233.1 6.8% 81.4%",
  input: "233.1 6.8% 81.4%",
  ring: "245 62% 57%",
  success: "160 84% 26%",
  successForeground: "0 0% 100%",
  warning: "41 96% 38%",
  warningForeground: "38 92% 12%",
  warningStrong: "41 96% 27%",
  canvasBackdrop: "hsl(233.1 12.5% 90.9%)",
  borderSoft: "color-mix(in oklch, hsl(var(--border)) 40%, transparent)",
  cardEdge: "color-mix(in oklch, hsl(var(--border)) 60%, transparent)",
  canvasRender: {
    grid: "#c0c0c0",
    snapGrid: "#a0a0a0",
    snapGuide: "#3b82f6",
    snapPage: "#f59e0b",
    snapElement: "#f43f5e",
    selectionStroke: "#00a1ff",
    selectionAnchorFill: "#ffffff",
    placeholderFill: "#1f2937",
    placeholderStroke: "#374151",
    brokenFill: "#e5e7eb",
    brokenStroke: "#9ca3af"
  }
};
var darkTheme = {
  background: "234.5 21.2% 9%",
  foreground: "233.2 14.8% 93.4%",
  card: "233.8 12.9% 15.4%",
  cardForeground: "233.2 14.8% 93.4%",
  popover: "233.6 9.3% 21.2%",
  popoverForeground: "233.2 14.8% 93.4%",
  primary: "239 84% 74%",
  // Inverted, not copied from light: white on this fill measures 3.02:1.
  primaryForeground: "234.9 28.5% 6.4%",
  secondary: "233.7 10.7% 19.3%",
  secondaryForeground: "233.2 14.8% 93.4%",
  muted: "233.7 10.7% 19.3%",
  mutedForeground: "239.6 1.5% 62.5%",
  accent: "233.7 10.7% 19.3%",
  accentForeground: "233.2 14.8% 93.4%",
  destructive: "348 90% 68%",
  destructiveForeground: "234.2 17.6% 11.3%",
  border: "233.4 7% 25.6%",
  input: "234.2 17.6% 11.3%",
  ring: "239 84% 74%",
  success: "160 70% 52%",
  successForeground: "160 84% 10%",
  warning: "40 94% 56%",
  warningForeground: "38 92% 12%",
  warningStrong: "40 94% 56%",
  canvasBackdrop: "hsl(234.9 28.5% 6.4%)",
  // The lifted border (L 0.365) leaves room to soften: 60% still reads 1.265
  // on the card, where the old border at full strength read 1.158.
  borderSoft: "color-mix(in oklch, hsl(var(--border)) 60%, transparent)",
  cardEdge: "color-mix(in oklch, hsl(var(--border)) 80%, transparent)",
  canvasRender: {
    grid: "#3a3a3a",
    snapGrid: "#5a5a5a",
    snapGuide: "#3b82f6",
    snapPage: "#f59e0b",
    snapElement: "#f43f5e",
    selectionStroke: "#00a1ff",
    selectionAnchorFill: "#e5e7eb",
    placeholderFill: "#2a2f3a",
    placeholderStroke: "#3f4654",
    brokenFill: "#262b33",
    brokenStroke: "#4b5563"
  }
};
function themeColor(value) {
  return /^(hsl|rgb|oklch|oklab|lch|lab|color|color-mix|#)/.test(value) ? value : `hsl(${value})`;
}
function themeToCssVars(theme) {
  return {
    "--background": theme.background,
    "--foreground": theme.foreground,
    "--card": theme.card,
    "--card-foreground": theme.cardForeground,
    "--popover": theme.popover,
    "--popover-foreground": theme.popoverForeground,
    "--primary": theme.primary,
    "--primary-foreground": theme.primaryForeground,
    "--secondary": theme.secondary,
    "--secondary-foreground": theme.secondaryForeground,
    "--muted": theme.muted,
    "--muted-foreground": theme.mutedForeground,
    "--accent": theme.accent,
    "--accent-foreground": theme.accentForeground,
    "--destructive": theme.destructive,
    "--destructive-foreground": theme.destructiveForeground,
    "--border": theme.border,
    "--input": theme.input,
    "--ring": theme.ring,
    "--success": theme.success,
    "--success-foreground": theme.successForeground,
    "--warning": theme.warning,
    "--warning-foreground": theme.warningForeground,
    // Falls back to the pairing the tinted surfaces used before this token
    // existed, so an unset value restores the previous look rather than an
    // unthemed one.
    "--warning-strong": theme.warningStrong ?? theme.warningForeground,
    "--bg-input": `hsl(${theme.card})`,
    "--text-primary": `hsl(${theme.foreground})`,
    "--text-secondary": `hsl(${theme.secondaryForeground})`,
    "--text-muted": `hsl(${theme.mutedForeground})`,
    "--text-danger": `hsl(${theme.destructive})`,
    "--border-default": `hsl(${theme.border})`,
    "--brand-primary": `hsl(${theme.primary})`,
    "--editor-selection-background": `hsl(${theme.primary})`,
    "--editor-selection-foreground": `hsl(${theme.background})`,
    "--canvas-backdrop": theme.canvasBackdrop,
    // Full strength is the safe default: an unset tier can under-draw an edge,
    // never erase one.
    "--border-soft": theme.borderSoft ?? `hsl(${theme.border})`,
    "--card-edge": theme.cardEdge ?? `hsl(${theme.border})`
  };
}

export {
  lightTheme,
  darkTheme,
  themeColor,
  themeToCssVars
};
//# sourceMappingURL=chunk-Q2QKEV6J.js.map