import { useEffect, useState } from 'react'
import { CanvasRoute } from './routes/CanvasRoute'
import { TimelineRoute } from './routes/TimelineRoute'
import { ChatRoute } from './routes/ChatRoute'

type ThemeName = 'light' | 'dark'

const ROUTES = [
  { path: '/canvas', label: 'Canvas' },
  { path: '/timeline', label: 'Timeline' },
  { path: '/chat', label: 'Chat' },
] as const

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
  return ROUTES.some((r) => r.path === path) ? path : '/canvas'
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
      <header className="flex shrink-0 items-center gap-1 border-b border-border bg-card px-4 py-2">
        <span className="mr-3 text-sm font-semibold">agent-app playground</span>
        <nav className="flex items-center gap-1">
          {ROUTES.map((r) => (
            <button
              key={r.path}
              type="button"
              onClick={() => navigate(r.path)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                path === r.path ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent/30'
              }`}
            >
              {r.label}
            </button>
          ))}
        </nav>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {theme === 'dark' ? 'Light' : 'Dark'} mode
        </button>
      </header>
      <main className="min-h-0 flex-1">
        {path === '/canvas' && <CanvasRoute />}
        {path === '/timeline' && <TimelineRoute />}
        {path === '/chat' && <ChatRoute />}
      </main>
    </div>
  )
}
