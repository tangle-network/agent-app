/**
 * Words found inside files, listed under the vault's name matches. Each row
 * names the file, its folder, and an excerpt with the query marked, and opens
 * the file through the pane's dirty-guarded navigation.
 */

import { useId, type ReactNode } from 'react'
import { FileText } from 'lucide-react'
import type { VaultContentMatch } from './contracts'

export type ContentSearchState =
  | { status: 'idle' }
  | { status: 'loading'; query: string; matches: VaultContentMatch[] }
  | { status: 'done'; query: string; matches: VaultContentMatch[] }
  | { status: 'error'; query: string; message: string }

/** Splits `text` so every case-insensitive occurrence of `query` is marked. */
function highlight(text: string, query: string): ReactNode[] {
  const needle = query.toLowerCase()
  const haystack = text.toLowerCase()
  const parts: ReactNode[] = []
  let from = 0
  for (let at = haystack.indexOf(needle); needle && at >= 0; at = haystack.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(
      <mark key={at} className="rounded-sm bg-[var(--surface-warning-bg)] px-0.5 text-[var(--surface-warning-text)]">
        {text.slice(at, at + needle.length)}
      </mark>,
    )
    from = at + needle.length
  }
  if (from < text.length) parts.push(text.slice(from))
  return parts
}

export function VaultContentResults({
  state,
  selectedPath,
  onOpen,
  onRetry,
}: {
  state: Exclude<ContentSearchState, { status: 'idle' }>
  selectedPath: string | null
  onOpen: (path: string) => void
  onRetry: () => void
}) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} data-vault-content-results className="mt-2 border-t border-border px-1.5 pt-3">
      <h3 id={headingId} className="px-1.5 text-sm font-medium text-foreground">
        In file contents
      </h3>
      {state.status === 'error' ? (
        <div role="alert" className="mt-2 space-y-2 px-1.5 text-sm text-[var(--surface-danger-text)]">
          <p>Couldn't search file contents. {state.message}</p>
          <button type="button" onClick={onRetry} className="font-medium underline-offset-2 hover:underline">
            Try again
          </button>
        </div>
      ) : state.matches.length === 0 ? (
        <p role="status" className="mt-2 px-1.5 text-sm text-muted-foreground">
          {state.status === 'loading' ? 'Searching file contents…' : `No file contains “${state.query}”.`}
        </p>
      ) : (
        <ul className="mt-1.5 space-y-0.5" aria-busy={state.status === 'loading'}>
          {state.matches.map((match) => {
            const slash = match.path.lastIndexOf('/')
            const selected = match.path === selectedPath
            return (
              <li key={match.path}>
                <button
                  type="button"
                  onClick={() => onOpen(match.path)}
                  title={match.path}
                  aria-current={selected ? 'true' : undefined}
                  className={`w-full rounded-md px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                    selected ? 'bg-muted' : 'hover:bg-muted'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 truncate text-sm font-medium text-foreground">{match.path.slice(slash + 1)}</span>
                    {slash > 0 && (
                      <span className="ml-auto min-w-0 shrink truncate text-sm text-muted-foreground">{match.path.slice(0, slash)}</span>
                    )}
                  </span>
                  <span className="mt-1 line-clamp-2 block text-sm text-muted-foreground">
                    {highlight(match.snippet, state.query)}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
