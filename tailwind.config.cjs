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
