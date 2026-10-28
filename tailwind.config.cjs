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
  // Package entries own dependency scanning; Storybook lists only its source.
  content: ['./src/**/*.{ts,tsx}', './.storybook/**/*.{ts,tsx,html}'],
}
