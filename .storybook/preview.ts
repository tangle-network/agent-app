import type { Decorator, Preview } from '@storybook/react'
import '../src/theme/tokens.css'
import './storybook.css'
import '../src/studio-react/studio.css'

// `body` backgrounds forced per theme, matching `--background` in
// src/theme/tokens.css — the style tag wins over any addon-imposed background
// (the backgrounds addon is disabled below for the same reason).
const THEME_BACKGROUNDS: Record<'dark' | 'light', string> = {
  dark: 'hsl(240 8% 5%)', // [data-theme='dark'] / .dark scope
  light: 'hsl(0 0% 100%)', // :root scope
}

/**
 * Applies the Storybook toolbar theme to the document the way a product shell
 * would: tokens.css scopes its dark values on BOTH `[data-theme='dark']` and
 * `.dark`, so the decorator sets the attribute AND the class on
 * `document.documentElement` (the tailwind preset's darkMode pair matches the
 * same two hooks, so `dark:` utilities follow too).
 */
const withAgentTheme: Decorator = (Story, context) => {
  const theme = context.globals.agentTheme === 'light' ? 'light' : 'dark'
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.classList.toggle('dark', theme === 'dark')

  let styleEl = document.getElementById('agent-theme-bg')
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = 'agent-theme-bg'
    document.head.appendChild(styleEl)
  }
  styleEl.textContent = `body { background: ${THEME_BACKGROUNDS[theme]} !important; }`

  return Story()
}

const preview: Preview = {
  decorators: [withAgentTheme],
  initialGlobals: {
    agentTheme: 'dark',
  },
  globalTypes: {
    agentTheme: {
      description: 'agent-app theme',
      toolbar: {
        title: 'Theme',
        icon: 'paintbrush',
        items: [
          { value: 'dark', title: 'Dark' },
          { value: 'light', title: 'Light' },
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
