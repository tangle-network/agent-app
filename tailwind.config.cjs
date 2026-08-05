// Storybook's Tailwind setup, mirroring the playground (the proven consumer).
// The package ships its preset as TS source; Tailwind 3.4 loads this config
// through jiti, so requiring the .ts preset directly works and stays in sync
// with src — no dependency on dist being built first. The interop fallback
// covers jiti returning either the module namespace or the default export.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const presetModule = require('./src/theme/tailwind-preset.ts')
const agentAppPreset = presetModule.default ?? presetModule

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [agentAppPreset],
  content: ['./src/**/*.{ts,tsx}', './.storybook/**/*.{ts,tsx,html}'],
}
