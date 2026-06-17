// The real consumer setup: agent-app ships a Tailwind preset that maps the
// shadcn semantic color names (bg-card, text-muted-foreground, border-border,
// …) used by web-react onto the CSS variables in its tokens.css. Wiring it here
// validates the preset + tokens exactly as a product would.
import preset from '@tangle-network/agent-app/tailwind-preset'

/** @type {import('tailwindcss').Config} */
export default {
  presets: [preset],
  // Scan the playground sources AND the linked package's dist — the dist .js
  // files carry the Tailwind class strings web-react/design-canvas/sequences
  // emit, so the JIT compiler must see them to generate the utilities.
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    './node_modules/@tangle-network/agent-app/dist/**/*.js',
  ],
}
