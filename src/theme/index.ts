/**
 * Design-token + theme contract for agent-app's React surfaces.
 *
 *   import '@tangle-network/agent-app/styles'           // tokens.css (variable values)
 *   import preset from '@tangle-network/agent-app/tailwind-preset'  // shadcn name → var map
 *   import { darkTheme, themeToCssVars } from '@tangle-network/agent-app/theme'  // JS/runtime
 *
 * Brand is the canonical source; this module exposes the generated compatibility mirror.
 */
export * from './theme'
