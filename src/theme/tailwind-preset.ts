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
 */

const withForeground = (name: string) => ({
  DEFAULT: `hsl(var(--${name}))`,
  foreground: `hsl(var(--${name}-foreground))`,
})

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
        warning: withForeground('warning'),
        card: withForeground('card'),
        popover: withForeground('popover'),
        primary: withForeground('primary'),
        secondary: withForeground('secondary'),
        muted: withForeground('muted'),
        accent: withForeground('accent'),
        destructive: withForeground('destructive'),
      },
    },
  },
}

export default agentAppPreset
