import { useEffect, useState } from 'react'
import { BrandHeader } from '@tangle-network/agent-app/brand'
import { CanvasRoute } from './routes/CanvasRoute'
import { TimelineRoute } from './routes/TimelineRoute'
import { ChatRoute } from './routes/ChatRoute'
import { ComposerRoute } from './routes/ComposerRoute'
import { RecordsRoute } from './routes/RecordsRoute'
import { StudioRoute } from './routes/StudioRoute'
import { WorkspaceRoute } from './routes/WorkspaceRoute'

type ThemeName = 'light' | 'dark'

const ROUTES = [
  { path: '/canvas', label: 'Design' },
  { path: '/timeline', label: 'Storyboard' },
  { path: '/chat', label: 'Agent' },
  { path: '/composer', label: 'Composer' },
  { path: '/records', label: 'Records' },
  { path: '/studio', label: 'Studio' },
  { path: '/workspace', label: 'Workspace' },
] as const

/** Reachable by URL but deliberately not in the nav: a state a browser audit
 *  needs on load, which the audit itself cannot reach by interacting first.
 *  `/studio/viewer` opens the media viewer so the popover hit test can probe
 *  the save-to-vault popover INSIDE it (see `StudioRoute`). */
const AUDIT_PATHS: readonly string[] = ['/studio/viewer']

function applyTheme(theme: ThemeName) {
  const root = document.documentElement
  if (theme === 'dark') {
    root.setAttribute('data-theme', 'dark')
    root.classList.add('dark')
  } else {
    root.removeAttribute('data-theme')
    root.classList.remove('dark')
  }
}

/** `?theme=dark` wins on first load (lets `bad` request a theme via URL); the
 *  toggle then drives it interactively. */
function initialTheme(): ThemeName {
  const param = new URLSearchParams(window.location.search).get('theme')
  return param === 'dark' ? 'dark' : 'light'
}

function currentPath(): string {
  const path = window.location.pathname
  return ROUTES.some((r) => r.path === path) || AUDIT_PATHS.includes(path) ? path : '/canvas'
}

export function App() {
  const [theme, setTheme] = useState<ThemeName>(initialTheme)
  const [path, setPath] = useState<string>(currentPath)

  useEffect(() => applyTheme(theme), [theme])

  useEffect(() => {
    const onPop = () => setPath(currentPath())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = (to: string) => {
    const url = new URL(window.location.href)
    url.pathname = to
    window.history.pushState({}, '', url)
    setPath(to)
  }

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      {path === '/workspace' ? (
        <WorkspaceRoute />
      ) : (
        <>
          <BrandHeader title="agent-app playground">
            <nav className="flex items-center gap-1" aria-label="Playground sections">
              {ROUTES.map((r) => (
                <button
                  key={r.path}
                  type="button"
                  onClick={() => navigate(r.path)}
                  aria-current={path === r.path ? 'page' : undefined}
                  className={`inline-flex min-h-[44px] items-center rounded-md px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    path === r.path ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent/30'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </nav>
            <button
              type="button"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              className="ml-1 inline-flex min-h-[44px] items-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {theme === 'dark' ? 'Light' : 'Dark'} mode
            </button>
          </BrandHeader>
          <main className="min-h-0 flex-1">
            {path === '/canvas' && <CanvasRoute />}
            {path === '/timeline' && <TimelineRoute />}
            {path === '/chat' && <ChatRoute />}
            {path === '/composer' && <ComposerRoute />}
            {path === '/records' && <RecordsRoute />}
            {path.startsWith('/studio') && <StudioRoute viewerOpen={path === '/studio/viewer'} />}
          </main>
        </>
      )}
    </div>
  )
}
