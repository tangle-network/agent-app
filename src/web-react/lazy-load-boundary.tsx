import { Component, createElement, lazy, useEffect, useState, type ComponentType, type ReactElement, type ReactNode } from 'react'

interface LazyLoadBoundaryProps {
  children: ReactNode
  renderFailure: (error: unknown) => ReactNode
}

/** Keep a failed lazy import inside the surface that requested it. */
export class LazyLoadBoundary extends Component<LazyLoadBoundaryProps, { failed: boolean; error: unknown }> {
  state = { failed: false, error: null as unknown }

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error }
  }

  render() {
    if (this.state.failed) return this.props.renderFailure(this.state.error)
    return this.props.children
  }
}

const ROUTE_RELOAD_KEY = 'agent-app:route-chunk-reload-at'
const ROUTE_RELOAD_WINDOW_MS = 60_000
const ROUTE_RELOAD_PARAM = '__agent_app_route_reload'
const CHUNK_LOAD_FAILURE =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|loading chunk .* failed|failed to load module script/i

/** A stale deployed HTML page can reference a chunk removed by the next deploy. */
function isChunkLoadFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: unknown; message?: unknown }
  return candidate.name === 'ChunkLoadError' ||
    (typeof candidate.message === 'string' && CHUNK_LOAD_FAILURE.test(candidate.message))
}

function loadFreshDocument(): void {
  const url = new URL(window.location.href)
  url.searchParams.set(ROUTE_RELOAD_PARAM, Date.now().toString(36))
  window.location.replace(url.toString())
}

function RouteLoadFailure({ error, autoReloadOnChunkError }: { error: unknown; autoReloadOnChunkError: boolean }) {
  useEffect(() => {
    if (!autoReloadOnChunkError || !isChunkLoadFailure(error) || typeof window === 'undefined') return
    try {
      const lastReload = Number(window.sessionStorage.getItem(ROUTE_RELOAD_KEY) ?? 0)
      const elapsed = Date.now() - lastReload
      if (lastReload > 0 && elapsed >= 0 && elapsed < ROUTE_RELOAD_WINDOW_MS) return
      window.sessionStorage.setItem(ROUTE_RELOAD_KEY, String(Date.now()))
      loadFreshDocument()
    } catch {
      // Storage may be disabled. The visible reload action remains available.
    }
  }, [error, autoReloadOnChunkError])

  return (
    <div role="alert" className="rounded-xl border border-border bg-card p-5 text-foreground">
      <p className="font-medium">This page couldn’t load.</p>
      <p className="mt-1 text-sm text-muted-foreground">Reload to try again.</p>
      <button
        type="button"
        className="mt-4 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={loadFreshDocument}
      >
        Reload page
      </button>
    </div>
  )
}

export interface RouteChunkBoundaryProps {
  children: ReactNode
  /** Enable only where a reload cannot discard unsaved work. Default: false. */
  autoReloadOnChunkError?: boolean
}

/** Wrap a lazy route and its Suspense fallback; recovery requests a fresh document URL. */
export function RouteChunkBoundary({ children, autoReloadOnChunkError = false }: RouteChunkBoundaryProps) {
  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has(ROUTE_RELOAD_PARAM)) return
    url.searchParams.delete(ROUTE_RELOAD_PARAM)
    window.history.replaceState(window.history.state, '', url)
  }, [])
  return (
    <LazyLoadBoundary renderFailure={(error) => <RouteLoadFailure error={error} autoReloadOnChunkError={autoReloadOnChunkError} />}>
      {children}
    </LazyLoadBoundary>
  )
}

/**
 * A lazily loaded route that renders synchronously once its module has loaded.
 *
 * `React.lazy` calls its loader only on first render, so even an already
 * downloaded chunk suspends once, and React holds that Suspense retry for its
 * ~300 ms fallback throttle. Hospitality measured 305 ms before the first data
 * read on every first visit to a lazy route, with the chunk already cached.
 * Each mount decides once which component it renders, so a route mounted
 * before its module arrived keeps its state when it re-renders later.
 */
export type LazyRoute<P extends object> = ((props: P) => ReactElement) & { preload: () => Promise<void> }

export function lazyRoute<P extends object>(load: () => Promise<ComponentType<P>>): LazyRoute<P> {
  let loaded: ComponentType<P> | null = null
  let pending: Promise<ComponentType<P>> | null = null
  const start = () => (pending ??= load().then(
    (component) => (loaded = component),
    (error: unknown) => { pending = null; throw error },
  ))
  const Lazy = lazy(() => start().then((component) => ({ default: component })))
  function Route(props: P) {
    const [Ready] = useState(() => loaded)
    return Ready ? createElement(Ready, props) : createElement(Lazy as unknown as ComponentType<P>, props)
  }
  return Object.assign(Route, { preload: () => start().then(() => undefined) })
}

/** Load routes while the browser is idle (at most `timeoutMs` later), so a first visit waits only on its data. */
export function preloadWhenIdle(routes: ReadonlyArray<{ preload: () => Promise<void> }>, timeoutMs = 3000): () => void {
  const run = () => { for (const route of routes) void route.preload().catch(() => { /* The route's boundary reports a failed load when it renders. */ }) }
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(run, { timeout: timeoutMs })
    return () => cancelIdleCallback(handle)
  }
  const handle = setTimeout(run, Math.min(timeoutMs, 1000))
  return () => clearTimeout(handle)
}
