/** Agent App's compatibility names over Brand's current tokens. Pair with ./styles. */
const withForeground = (name: string) => ({
  DEFAULT: `hsl(var(--${name}))`,
  foreground: `hsl(var(--${name}-foreground))`,
})
// Full-color tiers need an explicit alpha placeholder for Tailwind v3 /50 users.
const tier = (token: string) => `color-mix(in oklch, var(${token}) calc(<alpha-value> * 100%), transparent)`

const agentAppPreset = {
  darkMode: ['class', '[data-theme="dark"]'] as [string, string],
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        'input-fill': 'var(--bg-input)',
        ring: 'hsl(var(--ring))',
        success: withForeground('success'),
        warning: { ...withForeground('warning'), strong: 'hsl(var(--warning-strong))' },
        card: withForeground('card'),
        popover: withForeground('popover'),
        primary: withForeground('primary'),
        secondary: withForeground('secondary'),
        muted: withForeground('muted'),
        accent: withForeground('accent'),
        destructive: withForeground('destructive'),
        // Do not compress Brand's MD3 ladder onto three shadcn surfaces.
        'surface-container-lowest': 'var(--md3-surface-container-lowest)',
        'surface-container-low': 'var(--md3-surface-container-low)',
        'surface-container': 'var(--md3-surface-container)',
        'surface-container-high': 'var(--md3-surface-container-high)',
        'surface-container-highest': 'var(--md3-surface-container-highest)',
      },
      // A field's well and edge are separate Brand roles. Keep border-input
      // on --input while bg-input paints the full-color recessed well.
      backgroundColor: {
        input: 'color-mix(in oklch, var(--bg-input) calc(<alpha-value> * 100%), transparent)',
      },
      // Approval cards use a light tint; their label needs Brand's stronger
      // warning ink. The solid warning chip keeps its own foreground pairing.
      textColor: {
        warning: {
          DEFAULT: 'hsl(var(--warning-strong))',
          foreground: 'hsl(var(--warning-foreground))',
          strong: 'hsl(var(--warning-strong))',
        },
      },
      boxShadow: { raised: 'var(--shadow-raised)', overlay: 'var(--shadow-overlay)' },
      borderColor: {
        border: tier('--border-soft'),
        'card-edge': tier('--card-edge'),
        strong: 'hsl(var(--border))',
      },
      borderRadius: { control: 'var(--radius-sm)', card: 'var(--radius-lg)', surface: 'var(--radius-2xl)' },
      transitionDuration: {
        instant: 'var(--duration-instant)', fast: 'var(--duration-fast)',
        base: 'var(--duration-base)', slow: 'var(--duration-slow)',
      },
      transitionTimingFunction: {
        standard: 'var(--ease-standard)', entrance: 'var(--ease-entrance)', exit: 'var(--ease-exit)',
      },
      keyframes: {
        slideDown: { from: { height: '0' }, to: { height: 'var(--radix-collapsible-content-height)' } },
        slideUp: { from: { height: 'var(--radix-collapsible-content-height)' }, to: { height: '0' } },
      },
      animation: {
        slideDown: 'slideDown var(--duration-base) var(--ease-entrance)',
        slideUp: 'slideUp var(--duration-fast) var(--ease-exit)',
      },
    },
  },
}
export default agentAppPreset
