import type { Decorator, Preview } from '@storybook/react'
import '../src/theme/tokens.css'
import './storybook.css'
import '../src/studio-react/studio.css'
// AFTER tokens.css on purpose: brand-themes.css ties `:root`/`.dark` in
// specificity and must win by source order (see the note inside that file).
import './brand-themes.css'

interface AgentTheme {
  /**
   * tokens.css scopes its dark values on BOTH `[data-theme='dark']` and
   * `.dark`, so dark themes carry the class too. For the brand named themes
   * this doubles as the fallback source: tokens a named scope doesn't cover
   * (--success/--warning, --destructive on dark scopes, …) resolve to
   * agent-app's dark values instead of the light :root ones. The brand
   * scope's own declarations still win where both declare (source order).
   */
  dark: boolean
  /** Toolbar label; the `Dark ·` / `Light ·` group prefix comes from `dark`. */
  title: string
  /**
   * Value written to documentElement's `data-theme` attribute. Defaults to
   * the toolbar key: every brand named scope is named exactly like its key,
   * and only agent-app's own two themes rename (agent-dark → dark,
   * agent-light → light — the scopes tokens.css actually declares).
   */
  dataTheme?: string
}

const AGENT_DARK: AgentTheme = { dataTheme: 'dark', dark: true, title: 'Agent Dark (current)' }

/**
 * The toolbar vocabulary: every brand named theme (brand's named-themes.css)
 * plus agent-app's own two, dark group first — the toolbar item list below is
 * derived from this map, so a theme cannot drift out of one but not the
 * other. `dark` drives the `.dark` class: arena and intelligence ARE dark
 * themes (intelligence's brand selector `.dark[data-theme="intelligence"]`
 * even REQUIRES the class — without it the scope matches nothing), and
 * tangle-dark is dark by name. `light` is brand's canonical light spine — in
 * this Storybook it resolves to the same tokens as agent-light, because
 * agent-app's tokens.css owns the `:root` light values; it is listed so the
 * toolbar mirrors the brand vocabulary one for one.
 */
const AGENT_THEMES: Record<string, AgentTheme> = {
  'agent-dark': AGENT_DARK,
  aubergine: { dark: true, title: 'Aubergine' },
  arena: { dark: true, title: 'Arena' },
  intelligence: { dark: true, title: 'Intelligence' },
  'tangle-dark': { dark: true, title: 'Tangle Dark' },
  'agent-light': { dataTheme: 'light', dark: false, title: 'Agent Light (current)' },
  'aubergine-light': { dark: false, title: 'Aubergine Light' },
  'arena-light': { dark: false, title: 'Arena Light' },
  'tangle-light': { dark: false, title: 'Tangle Light' },
  light: { dark: false, title: 'Brand Light' },
}

// Toolbar values from the old binary dark/light switcher, so existing
// bookmarks/URLs keep working. `light` needs no entry: AGENT_THEMES has a
// `light` key with identical semantics, so old URLs resolve through the map
// like any current one.
const LEGACY_THEME_VALUES: Record<string, string> = {
  dark: 'agent-dark',
}

/**
 * True when the loaded named-themes.css carries the scope currently selected
 * on documentElement, probed via the spine token every named scope sets.
 * agent-app defines no `--hsl-*` of its own, so an empty read means the scope
 * is absent.
 */
const brandScopeLoaded = (): boolean =>
  getComputedStyle(document.documentElement).getPropertyValue('--hsl-background') !== ''

let tangleDarkFallbackWarned = false

/**
 * Applies the Storybook toolbar theme to the document the way a product shell
 * would: `data-theme` on `document.documentElement` (which is also :root, so
 * the brand named scopes and the alias bridge in brand-themes.css resolve on
 * the same element), plus the `.dark` class for dark themes (see AGENT_THEMES).
 */
const withAgentTheme: Decorator = (Story, context) => {
  const raw = String(context.globals.agentTheme ?? 'agent-dark')
  const requested = LEGACY_THEME_VALUES[raw] ?? raw
  const key = requested in AGENT_THEMES ? requested : 'agent-dark'
  const theme = AGENT_THEMES[key] ?? AGENT_DARK
  const root = document.documentElement
  root.setAttribute('data-theme', theme.dataTheme ?? key)
  root.classList.toggle('dark', theme.dark)

  if (key === 'tangle-dark' && !brandScopeLoaded()) {
    // brand ≤1.1.0 ships no tangle-dark scope; where the local alias (see
    // main.ts) is absent too, every token the bridge redeclares for it would
    // be guaranteed-invalid. Render agent-dark instead — loudly, once per
    // session, rather than silently painting agent-dark's values under a
    // tangle-dark label (which a CSS var() fallback would do, and drift).
    root.setAttribute('data-theme', 'dark')
    if (!tangleDarkFallbackWarned) {
      tangleDarkFallbackWarned = true
      console.info(
        "[storybook] brand's tangle-dark scope is not loaded (brand ≤1.1.0 and no local alias — see .storybook/main.ts); rendering agent-dark.",
      )
    }
  }

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
        // Derived from AGENT_THEMES (insertion order: dark group first), so
        // the toolbar can never disagree with the map about what exists or
        // which group a theme belongs to.
        items: Object.entries(AGENT_THEMES).map(([value, theme]) => ({
          value,
          title: `${theme.dark ? 'Dark' : 'Light'} · ${theme.title}`,
        })),
        dynamicTitle: true,
      },
    },
  },
  parameters: {
    backgrounds: { disable: true },
    /**
     * Center by default: most stories render a single component, and the
     * padded default anchored every one of them top-left. Stories that render
     * wide composites (> ~1100px) or multi-cell AllStates grids keep an
     * explicit `layout: 'padded'` — under `centered` an over-wide canvas
     * clips on the LEFT with no scroll affordance. Full-app shells keep
     * `fullscreen`. Upward-opening popovers (ModelPicker, EffortPicker, the
     * gear menu) use the `withPopoverHeadroom` decorator from
     * src/stories/chat-controls/fixtures.tsx regardless of layout — inline
     * `bottom-full` popovers otherwise extend into unscrollable negative-Y
     * space above the canvas.
     */
    layout: 'centered',
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /date$/i,
      },
    },
  },
}

export default preview
