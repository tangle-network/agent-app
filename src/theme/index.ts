/**
 * Design-token + theme contract for agent-app's React surfaces.
 *
 *   import '@tangle-network/agent-app/styles'           // tokens.css (variable values)
 *   import preset from '@tangle-network/agent-app/tailwind-preset'  // shadcn name → var map
 *   import { darkTheme, themeToCssVars } from '@tangle-network/agent-app/theme'  // JS/runtime
 *
 * The CSS file is the canonical source; this module is the typed JS mirror.
 */
export * from './theme'
