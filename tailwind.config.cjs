// Storybook's Tailwind setup, mirroring the playground (the proven consumer).
// The package ships its preset as TypeScript source. Tailwind loads this config
// through jiti, so requiring the preset directly works and stays in sync
// with src — no dependency on dist being built first. The interop fallback
// covers jiti returning either the module namespace or the default export.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const presetModule = require('./src/theme/tailwind-preset.ts')
const agentAppPreset = presetModule.default ?? presetModule

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [agentAppPreset],
  theme: {
    extend: {
      fontFamily: {
        // The brand mono stack (`--font-mono` in @tangle-network/brand's
        // tokens.css). Geist Mono is loaded in .storybook/preview-head.html;
        // without this mapping Tailwind's default ui-monospace stack owns
        // `font-mono` and every mono surface renders per-machine OS mono.
        mono: ['"Geist Mono"', '"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  // The package sources plus the linked UI libraries whose components are
  // re-exported into agent-app surfaces (e.g. sandbox-ui/primitives' Dialog,
  // consumed by studio-react). Without scanning them, their class strings
  // (shadcn dialog centering: left-[50%]/top-[50%]/translate-x-[-50%]…) emit
  // no CSS and forwarded components render unstyled — e.g. modals anchored to
  // the bottom-left corner instead of centered.
  content: [
    './src/**/*.{ts,tsx}',
    './.storybook/**/*.{ts,tsx,html}',
    './node_modules/@tangle-network/sandbox-ui/src/**/*.{ts,tsx}',
    './node_modules/@tangle-network/sandbox-ui/dist/**/*.js',
    './node_modules/@tangle-network/ui/src/**/*.{ts,tsx}',
    './node_modules/@tangle-network/ui/dist/**/*.js',
  ],
}
