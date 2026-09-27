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
    background: string;
    foreground: string;
    card: string;
    cardForeground: string;
    popover: string;
    popoverForeground: string;
    primary: string;
    primaryForeground: string;
    secondary: string;
    secondaryForeground: string;
    muted: string;
    mutedForeground: string;
    accent: string;
    accentForeground: string;
    destructive: string;
    destructiveForeground: string;
    border: string;
    input: string;
    ring: string;
    success: string;
    successForeground: string;
    warning: string;
    warningForeground: string;
    /**
     * Warning as TEXT on a warning-TINTED surface, as a channel triple. Optional
     * so a consumer's existing `AgentAppTheme` literal still type-checks;
     * {@link themeToCssVars} falls back to `warningForeground`, which is what the
     * surface used before this token existed.
     */
    warningStrong?: string;
    /** Full CSS color (not a triple) — the canvas/scene backdrop. */
    canvasBackdrop: string;
    /**
     * Border tiers as FULL CSS colors (they are `color-mix()` results, not
     * triples). Optional so a consumer's existing `AgentAppTheme` literal still
     * type-checks; {@link themeToCssVars} falls back to full-strength
     * `hsl(var(--border))`, which can never erase an edge.
     */
    borderSoft?: string;
    /** @see borderSoft */
    cardEdge?: string;
    /** Konva render palette — full hex colors the bitmap canvas paints with
     *  (it cannot resolve `var(--…)`). NOT emitted by themeToCssVars. */
    canvasRender: CanvasRenderPalette;
}
/**
 * Colors the Konva design-canvas paints directly. Konva renders to a bitmap
 * and cannot read CSS custom properties, so these are full hex strings sourced
 * from the active theme and threaded through the canvas components.
 */
export interface CanvasRenderPalette {
    /** Grid line color (GridLayer). */
    grid: string;
    /** Grid-snap guide line (SnapGuidesOverlay, kind 'grid'). */
    snapGrid: string;
    /** Saved ruler-guide snap line (kind 'guide'). */
    snapGuide: string;
    /** Page edge/center snap line (kinds 'page-edge'/'page-center'). */
    snapPage: string;
    /** Element edge/center snap line (kinds 'element-edge'/'element-center'). */
    snapElement: string;
    /** Transformer border + anchor stroke (SelectionLayer). */
    selectionStroke: string;
    /** Transformer anchor fill (SelectionLayer). */
    selectionAnchorFill: string;
    /** Video placeholder fill (ElementNode VideoNode). */
    placeholderFill: string;
    /** Video placeholder stroke (ElementNode VideoNode). */
    placeholderStroke: string;
    /** Broken/loading image placeholder fill (ElementNode ImageNode). */
    brokenFill: string;
    /** Broken/loading image placeholder stroke (ElementNode ImageNode). */
    brokenStroke: string;
}
/** Define a light color theme with specific background, foreground, and accent color values */
export declare const lightTheme: AgentAppTheme;
/** Define a dark color scheme for the Agent app interface with specific background and foreground hues */
export declare const darkTheme: AgentAppTheme;
/**
 * Wrap a channel triple in `hsl()`; pass through values already in a color form.
 * `oklch(…)` / `oklab(…)` / `color-mix(…)` are recognised because the ramp is
 * authored in oklch and the border tiers are colour mixes — wrapping either in
 * `hsl()` yields an invalid colour that paints as nothing.
 */
export declare function themeColor(value: string): string;
/**
 * Map a theme to the full CSS-variable set (shadcn triples + canvas/sequences
 * aliases + canvas surface). Apply at runtime to scope a theme without loading
 * tokens.css: `Object.assign(el.style, themeToCssVars(darkTheme))`.
 */
export declare function themeToCssVars(theme: AgentAppTheme): Record<string, string>;
