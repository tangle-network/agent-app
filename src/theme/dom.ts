import { darkTheme, lightTheme, themeColor } from './theme'

export type ThemePreference = 'light' | 'dark' | 'system'

/**
 * Mobile browser-chrome colors track the Brand canvas the shared stylesheet
 * paints the page with, so the address bar matches the surface behind it.
 * Read from the generated Brand snapshot, never restated by a product.
 */
export const LIGHT_THEME_COLOR = themeColor(lightTheme.background)
export const DARK_THEME_COLOR = themeColor(darkTheme.background)

/** Mirror a dark/light flip onto the `.dark`/`.light` classes and the color-scheme/theme-color metas. */
export function applyThemeDom(dark: boolean, doc: Document = document) {
  const root = doc.documentElement
  root.classList.toggle('dark', dark)
  root.classList.toggle('light', !dark)

  const colorScheme = doc.querySelector('meta[name="color-scheme"]')
  if (colorScheme) colorScheme.setAttribute('content', dark ? 'dark' : 'light')

  const metaThemeColor = doc.querySelector('meta[name="theme-color"]')
  if (metaThemeColor) metaThemeColor.setAttribute('content', dark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR)
}

export function resolveThemePreference(theme: ThemePreference, win: Window = window): boolean {
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return win.matchMedia('(prefers-color-scheme: dark)').matches
}

/** True while the stored preference is System (the `theme` key is absent or not an explicit choice). */
export function shouldFollowSystemTheme(storage: Storage = localStorage): boolean {
  const theme = storage.getItem('theme')
  return theme !== 'light' && theme !== 'dark'
}

export function syncThemePreference(theme: ThemePreference) {
  applyThemeDom(resolveThemePreference(theme))
}

/**
 * Inline script applied before paint so there is no flash of the wrong theme.
 * An explicit 'light'/'dark' in the `theme` key wins; anything else (unset →
 * System) follows the OS. The account-menu Appearance control writes that key
 * (removing it for System), so this script must never write it. The shell
 * always carries `[data-sandbox-ui]`, whose default tokens are dark, so both
 * explicit theme classes are toggled for light tokens to win on every surface.
 */
export const THEME_BOOTSTRAP_SCRIPT = `
  try {
    var t = localStorage.getItem('theme');
    var dark = t === 'dark' || (t !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.classList.toggle('light', !dark);
    var m = document.querySelector('meta[name="color-scheme"]');
    if (m) m.content = dark ? 'dark' : 'light';
    var c = document.querySelector('meta[name="theme-color"]');
    if (c) c.content = dark ? ${JSON.stringify(DARK_THEME_COLOR)} : ${JSON.stringify(LIGHT_THEME_COLOR)};
  } catch(e) {}
`
