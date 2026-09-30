import { Component, useEffect, type ReactNode } from 'react'

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
const CHUNK_LOAD_FAILURE =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|loading chunk .* failed|failed to load module script/i

/** A stale deployed HTML page can reference a chunk removed by the next deploy. */
function isChunkLoadFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: unknown; message?: unknown }
  return candidate.name === 'ChunkLoadError' ||
    (typeof candidate.message === 'string' && CHUNK_LOAD_FAILURE.test(candidate.message))
}

function RouteLoadFailure({ error, autoReloadOnChunkError }: { error: unknown; autoReloadOnChunkError: boolean }) {
  useEffect(() => {
    if (!autoReloadOnChunkError || !isChunkLoadFailure(error) || typeof window === 'undefined') return
    try {
      const lastReload = Number(window.sessionStorage.getItem(ROUTE_RELOAD_KEY) ?? 0)
      const elapsed = Date.now() - lastReload
      if (lastReload > 0 && elapsed >= 0 && elapsed < ROUTE_RELOAD_WINDOW_MS) return
      window.sessionStorage.setItem(ROUTE_RELOAD_KEY, String(Date.now()))
      window.location.reload()
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
        onClick={() => window.location.reload()}
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

/** Wrap a lazy route and its Suspense fallback to recover after a deploy changes chunk URLs. */
export function RouteChunkBoundary({ children, autoReloadOnChunkError = false }: RouteChunkBoundaryProps) {
  return (
    <LazyLoadBoundary renderFailure={(error) => <RouteLoadFailure error={error} autoReloadOnChunkError={autoReloadOnChunkError} />}>
      {children}
    </LazyLoadBoundary>
  )
}
