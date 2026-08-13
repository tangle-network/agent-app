/**
 * Tailwind preset mapping the shadcn semantic color names used by web-react
 * (bg-card, text-muted-foreground, border-border, …) onto the CSS variables in
 * tokens.css — so a consuming app themes every agent-app surface from one source.
 *
 *   // tailwind.config.{js,ts}
 *   import agentAppPreset from '@tangle-network/agent-app/tailwind-preset'
 *   export default { presets: [agentAppPreset], content: [...] }
 *
 * Pair with `import '@tangle-network/agent-app/styles'` for the variable values.
 * design-canvas/sequences need no preset — they consume vars via arbitrary
 * values (bg-[var(--bg-input)]), which Tailwind supports without color config.
 *
 * Beyond colour this preset also maps the border TIERS, the semantic radius
 * steps, the motion scale, and the elevation shadows. See docs/design-tokens.md.
 */

const withForeground = (name: string) => ({
  DEFAULT: `hsl(var(--${name}))`,
  foreground: `hsl(var(--${name}-foreground))`,
})

/**
 * A border tier as a Tailwind colour that still honours the `/40` opacity
 * modifier.
 *
 * The tier tokens are `color-mix()` results, not channel triples, and Tailwind
 * cannot inject an alpha into a value it cannot parse — pointing `border-border`
 * straight at `var(--border-soft)` makes Tailwind DROP `border-border/50`
 * entirely rather than emit it without the modifier, which is silent: the
 * element falls back to `currentColor` and nothing errors. This package has 18
 * such usages. Wrapping the token in a `color-mix` that consumes
 * `<alpha-value>` keeps the token as the source AND composes with the modifier:
 * bare → 100% of the tier, `/50` → half of it.
 */
const tier = (token: string) => `color-mix(in oklch, var(${token}) calc(<alpha-value> * 100%), transparent)`

/** Define a preset configuration for dark mode and extended theme colors with foreground variants */
const agentAppPreset = {
  darkMode: ['class', '[data-theme="dark"]'] as [string, string],
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        success: withForeground('success'),
        // `strong` sits alongside DEFAULT/foreground rather than replacing
        // either: `--warning` is the dot/border/tint hue, `--warning-foreground`
        // is what goes on a SOLID gold chip, and `text-warning-strong` is the
        // only one of the three that stays legible as text on a warning TINT in
        // both themes.
        warning: { ...withForeground('warning'), strong: 'hsl(var(--warning-strong))' },
        card: withForeground('card'),
        popover: withForeground('popover'),
        primary: withForeground('primary'),
        secondary: withForeground('secondary'),
        muted: withForeground('muted'),
        accent: withForeground('accent'),
        destructive: withForeground('destructive'),
        // MD3 surface ladder — wires sandbox-ui's `bg-surface-container*`
        // utilities (used by AgentComposer + its pickers) onto the shadcn
        // elevation triples, so those components render on-palette here.
        // Monotonic in the dark theme: card (L 0.235) < secondary (0.285) <
        // popover (0.325) — the rungs a container climbs as it floats higher.
        'surface-container': 'hsl(var(--card))',
        'surface-container-high': 'hsl(var(--secondary))',
        'surface-container-highest': 'hsl(var(--popover))',
      },
      // Elevation shadows — `shadow-raised` for the floating composer,
      // `shadow-overlay` for popovers/dialogs. Both re-theme through
      // tokens.css (dark doubles the alpha at the token).
      boxShadow: {
        raised: 'var(--shadow-raised)',
        overlay: 'var(--shadow-overlay)',
      },
      // Border tiers. `borderColor` is a separate scale from `colors`, so
      // pointing `border-border` at the soft tier here leaves `bg-border` /
      // `text-border` (and the `--border` triple itself) at full strength.
      //
      // This is the one place a single edit reaches every `border-border` in
      // the fleet — 151 in this package alone — which is the only reason the
      // tiers are worth having. Editing 151 call sites to say `border-soft`
      // would be the same change spelled 151 times, and the next component
      // written would still say `border-border`.
      //
      // `border-input` is untouched on purpose: a form field's edge is a
      // control affordance, not a divider.
      //
      // Opting out is one line in the consumer's own config
      // (`borderColor: { border: 'hsl(var(--border))' }`) or one line in its
      // CSS (`--border-soft: hsl(var(--border))`), and the second also restores
      // the pre-tier look for any consumer-owned `--color-border` mapping,
      // which a Tailwind v4 app defines in its own `@theme` and this preset
      // cannot reach.
      borderColor: {
        border: tier('--border-soft'),
        'card-edge': tier('--card-edge'),
        strong: 'hsl(var(--border))',
      },
      // Semantic radius. Deliberately NOT a remap of Tailwind's `rounded-md` /
      // `rounded-lg`: those names collide with the token ladder's names at
      // DIFFERENT values (`--radius-md` is 8px, `rounded-md` is 6px), so
      // remapping would silently resize 302 existing `rounded-*` usages across
      // four products. New names, opt-in, no resize.
      borderRadius: {
        control: 'var(--radius-sm)',
        card: 'var(--radius-lg)',
        surface: 'var(--radius-2xl)',
      },
      // Motion. Additive names alongside Tailwind's numeric durations and
      // in/out/in-out curves, so `duration-fast` and `ease-entrance` compile
      // without displacing `duration-150` or `ease-out`.
      transitionDuration: {
        instant: 'var(--duration-instant)',
        fast: 'var(--duration-fast)',
        base: 'var(--duration-base)',
        slow: 'var(--duration-slow)',
      },
      transitionTimingFunction: {
        standard: 'var(--ease-standard)',
        entrance: 'var(--ease-entrance)',
        exit: 'var(--ease-exit)',
      },
      // Radix-collapsible row reveals, used by @tangle-network/ui's RunRowShell
      // (the shared run-row grammar this package composes). Named exactly as the
      // shell references them (`animate-slideDown`/`animate-slideUp`); height
      // animates against Radix's measured --radix-collapsible-content-height,
      // not a max-height guess.
      keyframes: {
        slideDown: {
          from: { height: '0' },
          to: { height: 'var(--radix-collapsible-content-height)' },
        },
        slideUp: {
          from: { height: 'var(--radix-collapsible-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        slideDown: 'slideDown var(--duration-base) var(--ease-entrance)',
        slideUp: 'slideUp var(--duration-fast) var(--ease-exit)',
      },
    },
  },
}

export default agentAppPreset
