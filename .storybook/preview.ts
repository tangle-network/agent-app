import type { Decorator, Preview } from '@storybook/react'
import '../src/theme/tokens.css'
import './storybook.css'
import '../src/studio-react/studio.css'
// AFTER tokens.css on purpose: brand-themes.css ties `:root`/`.dark` in
// specificity and must win by source order (see the note inside that file).
import './brand-themes.css'

interface AgentTheme {
  /** value written to documentElement's `data-theme` attribute */
  dataTheme: string
  /**
   * tokens.css scopes its dark values on BOTH `[data-theme='dark']` and
   * `.dark`, so dark themes carry the class too. For the brand named themes
   * this doubles as the fallback source: tokens a named scope doesn't cover
   * (--success/--warning, --destructive on dark scopes, …) resolve to
   * agent-app's dark values instead of the light :root ones. The brand
   * scope's own declarations still win where both declare (source order).
   */
  dark: boolean
}

const AGENT_THEMES: Record<string, AgentTheme> = {
  'agent-dark': { dataTheme: 'dark', dark: true },
  'agent-light': { dataTheme: 'light', dark: false },
  aubergine: { dataTheme: 'aubergine', dark: true },
  'aubergine-light': { dataTheme: 'aubergine-light', dark: false },
  'arena-light': { dataTheme: 'arena-light', dark: false },
  'tangle-light': { dataTheme: 'tangle-light', dark: false },
}

// Toolbar values from the old binary dark/light switcher, so existing
// bookmarks/URLs keep working.
const LEGACY_THEME_VALUES: Record<string, string> = {
  dark: 'agent-dark',
  light: 'agent-light',
}

/**
 * Applies the Storybook toolbar theme to the document the way a product shell
 * would: `data-theme` on `document.documentElement` (which is also :root, so
 * the brand named scopes and the alias bridge in brand-themes.css resolve on
 * the same element), plus the `.dark` class for dark themes (see AGENT_THEMES).
 */
const withAgentTheme: Decorator = (Story, context) => {
  const raw = String(context.globals.agentTheme ?? 'agent-dark')
  const key = LEGACY_THEME_VALUES[raw] ?? raw
  const theme = AGENT_THEMES[key] ?? AGENT_THEMES['agent-dark']
  const root = document.documentElement
  root.setAttribute('data-theme', theme.dataTheme)
  root.classList.toggle('dark', theme.dark)

  // `body` background forced from the ACTIVE theme's own `--background`
  // triple — var-driven, so every theme (including the brand named ones)
  // resolves its own canvas color with nothing hardcoded to drift. The style
  // tag wins over any addon-imposed background (the backgrounds addon is
  // disabled below for the same reason).
  let styleEl = document.getElementById('agent-theme-bg')
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = 'agent-theme-bg'
    document.head.appendChild(styleEl)
  }
  styleEl.textContent = 'body { background: hsl(var(--background)) !important; }'

  return Story()
}

const preview: Preview = {
  decorators: [withAgentTheme],
  initialGlobals: {
    agentTheme: 'agent-dark',
  },
  globalTypes: {
    agentTheme: {
      description: 'agent-app theme',
      toolbar: {
        title: 'Theme',
        icon: 'paintbrush',
        items: [
          { value: 'agent-dark', title: 'Agent Dark (current)' },
          { value: 'agent-light', title: 'Agent Light (current)' },
          { value: 'aubergine', title: 'Aubergine' },
          { value: 'aubergine-light', title: 'Aubergine Light' },
          { value: 'arena-light', title: 'Arena Light' },
          { value: 'tangle-light', title: 'Tangle Light' },
        ],
        dynamicTitle: true,
      },
    },
  },
  parameters: {
    backgrounds: { disable: true },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /date$/i,
      },
    },
  },
}

export default preview
