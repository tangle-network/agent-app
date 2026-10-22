import { useEffect, type HTMLAttributes, type ReactNode } from 'react'
import { Links, Meta, Scripts, ScrollRestoration, isRouteErrorResponse, type LinksFunction } from 'react-router'
import {
  applyThemeDom,
  DARK_THEME_COLOR,
  LIGHT_THEME_COLOR,
  shouldFollowSystemTheme,
  THEME_BOOTSTRAP_SCRIPT,
} from '../theme/dom'
import { darkTheme, lightTheme, themeColor } from '../theme/theme'

/**
 * The shared `useTheme` hook toggles only `.dark` on <html>. This mirrors every
 * such flip onto the `.light` class and the color-scheme/theme-color metas, and
 * tracks OS appearance changes while the preference is System.
 */
export function ThemeClassSync() {
  useEffect(() => {
    const root = document.documentElement
    const sync = () => {
      applyThemeDom(root.classList.contains('dark'))
    }
    const syncSystemTheme = () => {
      if (!shouldFollowSystemTheme()) return
      applyThemeDom(window.matchMedia('(prefers-color-scheme: dark)').matches)
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', syncSystemTheme)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', syncSystemTheme)
    }
  }, [])
  return null
}

export interface AppDocumentProps {
  children: ReactNode
  /** Theme the server renders before the bootstrap script runs. */
  defaultTheme: 'light' | 'dark'
  bodyClassName?: string
  /** Extra attributes on <html>, such as `data-density`. */
  htmlAttributes?: HTMLAttributes<HTMLHtmlElement> & Record<`data-${string}`, string>
  /** Rendered first in the body, after the theme script (a skip link). */
  before?: ReactNode
  /** Rendered after the route content (a toaster). */
  after?: ReactNode
}

/** The root route's `Layout`: document shell, theme bootstrap, scroll restoration and scripts. */
export function AppDocument({ children, defaultTheme, bodyClassName, htmlAttributes, before, after }: AppDocumentProps) {
  return (
    <html lang="en" suppressHydrationWarning className={defaultTheme} data-sandbox-ui {...htmlAttributes}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content={defaultTheme === 'dark' ? DARK_THEME_COLOR : LIGHT_THEME_COLOR} />
        <meta name="color-scheme" content={defaultTheme} />
        <Meta />
        <Links />
      </head>
      <body className={bodyClassName}>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
        {before}
        <ThemeClassSync />
        {children}
        {after}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

/** A data-URI SVG favicon whose strokes follow the Brand foreground in light and dark. `shapes` is the SVG `<path>` markup. */
export function svgFaviconHref(shapes: string): string {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + `<style>path{stroke:${themeColor(lightTheme.foreground)}}@media (prefers-color-scheme: dark){path{stroke:${themeColor(darkTheme.foreground)}}}</style>`
      + shapes
      + '</svg>',
  )
}

/** The root route's `links`: favicon, the app stylesheet, Inter, and any extra font stylesheets. */
export function appDocumentLinks(options: { stylesheet: string; favicon: string; extraStylesheets?: readonly string[] }): ReturnType<LinksFunction> {
  return [
    { rel: 'icon', href: options.favicon, type: 'image/svg+xml' },
    { rel: 'stylesheet', href: options.stylesheet },
    { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
    { rel: 'dns-prefetch', href: 'https://fonts.googleapis.com' },
    { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
    { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap' },
    ...(options.extraStylesheets ?? []).map((href) => ({ rel: 'stylesheet', href })),
  ]
}

/** The message and, outside a route response, the stack a root error screen shows. */
export function describeRouteError(error: unknown): { message: string; stack?: string } {
  if (isRouteErrorResponse(error)) {
    return { message: error.status === 404 ? 'Page not found' : error.statusText || 'An unexpected error occurred' }
  }
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: 'An unexpected error occurred' }
}

/**
 * Wrap `window.fetch` for the page's lifetime so `onResponse` sees every
 * response. Read a body from `response.clone()`; the caller still gets the
 * original untouched. Install from an effect and call the result to restore.
 */
export function installFetchResponseObserver(onResponse: (response: Response, args: Parameters<typeof fetch>) => void | Promise<void>): () => void {
  const original = window.fetch
  window.fetch = async (...args) => {
    const response = await original(...args)
    await onResponse(response, args)
    return response
  }
  return () => {
    window.fetch = original
  }
}
