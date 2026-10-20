import { Component, useId, type ErrorInfo, type ReactNode } from 'react'
import { FileText, Plus } from 'lucide-react'
import type { VaultOperationFailure } from './contracts'

export function operationMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function treeFailureMessage(failure: VaultOperationFailure, label: string): string {
  if (failure.phase !== 'post-mutation-refresh') return failure.message
  const completed = failure.operation === 'create' ? 'created' : 'deleted'
  return `The file was ${completed}, but ${label} couldn't refresh. ${failure.message}`
}

export class EditorErrorBoundary extends Component<{ children: ReactNode; label: string; onReset?: () => void }, { error: unknown }> {
  state: { error: unknown } = { error: null }
  static getDerivedStateFromError(error: unknown) {
    return { error }
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Vault crashed:', error, info)
  }
  render() {
    if (this.state.error) {
      const msg = this.state.error instanceof Error
        ? this.state.error.message
        : typeof this.state.error === 'string'
          ? this.state.error
          : `${this.props.label} did not load. Reload the page to try again.`
      return (
        <div className="flex h-full flex-1 flex-col items-center justify-center p-8 text-center">
          <h3 className="mb-1 text-sm font-medium text-foreground">{this.props.label} failed to load</h3>
          <p className="mb-4 max-w-xs text-xs text-muted-foreground">{String(msg)}</p>
          <button
            type="button"
            onClick={() => { this.setState({ error: null }); this.props.onReset?.() }}
            className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * A skeleton is a picture of a wait, and a picture is exactly what a screen
 * reader cannot see. `aria-hidden` on the shimmer bars is right — they carry no
 * information — but hiding them without saying anything else is what left the
 * whole load silent. The container announces the wait instead: `aria-busy` for
 * the state, a `status` live region so arrival is reported, and a real text
 * label, since a live region with only decorative children announces nothing.
 */
function SkeletonRegion({ label, className, children }: { label: string; className: string; children: ReactNode }) {
  // The live region is a SIBLING of the shimmer, not a wrapper around it: the
  // shimmer container keeps its exact classes and its exact position in the
  // parent's layout, so adding the announcement cannot move a pixel. Wrapping
  // it would put a new box between `space-y-*` and the bars it spaces.
  return (
    <>
      <span role="status" aria-live="polite" aria-busy={true} className="sr-only">
        {label}
      </span>
      <div className={className} aria-hidden="true">
        {children}
      </div>
    </>
  )
}

export function TreeSkeleton() {
  return (
    <SkeletonRegion label="Loading files…" className="space-y-2 p-4">
      {[32, 48, 40, 52].map((w, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-muted" style={{ width: `${w * 4}px` }} />
      ))}
    </SkeletonRegion>
  )
}

export function EditorSkeleton() {
  return (
    <SkeletonRegion label="Loading file…" className="space-y-3 p-8">
      <div className="h-5 w-1/2 animate-pulse rounded bg-muted" />
      <div className="h-4 w-full animate-pulse rounded bg-muted" />
      <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
    </SkeletonRegion>
  )
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
      >
        Retry
      </button>
  )
}

export function ReadErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div>
        <h3 className="text-sm font-medium text-foreground">Couldn't open this file</h3>
        <p className="mt-1 max-w-md text-xs text-muted-foreground">{message}</p>
      </div>
      <RetryButton onRetry={onRetry} />
    </div>
  )
}

export function TreeErrorState({ label, message, onRetry }: { label: string; message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div>
        <h3 className="text-sm font-medium text-foreground">Couldn't load {label}</h3>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">{message}</p>
      </div>
      <RetryButton onRetry={onRetry} />
    </div>
  )
}

/**
 * The tree pane when the vault holds nothing at all. It sits under the header
 * whose controls add files, so it names the state and offers the same action
 * instead of leaving a blank column under a search box with nothing to search.
 */
export function TreeEmptyState({ canCreate, onCreate }: { canCreate: boolean; onCreate: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div>
        <h3 className="text-sm font-medium text-foreground">No files yet</h3>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
          {canCreate ? 'Create a file to start.' : 'Files appear here once they are added.'}
        </p>
      </div>
      {canCreate && (
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          New file
        </button>
      )}
    </div>
  )
}

export function TreeNoMatchState({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 p-6 text-center">
      <p className="max-w-xs break-words text-xs text-muted-foreground">No files match “{query}”.</p>
      <button
        type="button"
        onClick={onClear}
        className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
      >
        Clear search
      </button>
    </div>
  )
}

export function OperationErrorAlert({
  message,
  retryLabel,
  onRetry,
  onDismiss,
}: {
  message: string
  retryLabel: string
  onRetry: () => void
  onDismiss: () => void
}) {
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-[var(--surface-danger-text)]"
    >
      <span className="min-w-0 flex-1">{message}</span>
      <div className="flex shrink-0 items-center gap-3">
        <button type="button" aria-label={retryLabel} onClick={onRetry} className="font-medium underline-offset-2 hover:underline">
          Retry
        </button>
        <button type="button" onClick={onDismiss} className="underline-offset-2 hover:underline">
          Dismiss
        </button>
      </div>
    </div>
  )
}

/**
 * The document pane with nothing open: says what to do, and offers the files
 * this reader opened last in this vault so returning work is one click away.
 */
export function DocumentEmptyState({ label, recent, onOpen }: { label: string; recent: string[]; onOpen: (path: string) => void }) {
  const recentHeadingId = useId()
  return (
    <div data-vault-document-empty className="flex h-full items-center justify-center overflow-y-auto p-8">
      <div className="w-full max-w-sm text-center">
        <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <FileText className="size-5" aria-hidden="true" />
        </span>
        <h3 className="mt-4 text-base font-semibold text-foreground">Select a file</h3>
        <p className="mt-1 text-sm text-muted-foreground">Choose a file in {label} to open it here.</p>
        {recent.length > 0 && (
          <section aria-labelledby={recentHeadingId} className="mt-8 text-left">
            <h4 id={recentHeadingId} className="text-xs font-medium text-muted-foreground">Recently opened</h4>
            <ul className="mt-2 overflow-hidden rounded-xl border border-border bg-card shadow-raised">
              {recent.map((path) => {
                const slash = path.lastIndexOf('/')
                return (
                  <li key={path} className="border-b border-border last:border-b-0">
                    <button
                      type="button"
                      onClick={() => onOpen(path)}
                      title={path}
                      className="flex min-h-10 w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 truncate font-medium">{path.slice(slash + 1)}</span>
                      {slash > 0 && <span className="ml-auto min-w-0 shrink truncate text-xs text-muted-foreground">{path.slice(0, slash)}</span>}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}
