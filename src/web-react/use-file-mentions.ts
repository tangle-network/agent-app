/**
 * `useFileMentions` — the glue a host passes straight into `AgentComposer`'s
 * `mention` prop (`@tangle-network/sandbox-ui#184`) to wire up `@`-file
 * mentions against `createSandboxFileIndexRoute` (`/chat-routes`).
 *
 * Fetches the index once per session from `indexUrl`, refreshes it in the
 * background whenever the popover opens (a `fetchItems` call) if the cached
 * copy has aged past `refreshAfterMs`, and answers every keystroke from an
 * in-memory fuzzy filter — no per-keystroke network round trip.
 *
 * `MentionItem`/the `mention` prop shape mirror the FROZEN contract from
 * sandbox-ui#184 structurally (no import: `/web-react` stays dependency-free
 * beyond React, and `@tangle-network/sandbox-ui` is an optional peer).
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { FileIndexResponse, FileIndexReadyResponse } from '../chat-routes/file-index'
import type { FileMention } from '../chat-routes/wire'

/** Mirrors sandbox-ui#184's `MentionItem` — the atomic pill's payload. For a
 *  file mention, `id` is the workspace-relative path (the pill's stable
 *  identity and the `@<id>` serialization sandbox-ui uses to round-trip
 *  `value`), `label` is the display name, and `detail` carries the full path
 *  for the popover row's secondary line. */
export interface MentionItem {
  id: string
  label: string
  detail?: string
  kind?: string
}

/** Mirrors sandbox-ui#184's `AgentComposerProps['mention']` shape — plug the
 *  hook's `mention` return value straight into that prop. */
export interface ComposerMentionProp {
  trigger?: string
  fetchItems(query: string): Promise<MentionItem[]>
  onMentionsChange?(mentions: MentionItem[]): void
  renderItem?(item: MentionItem): ReactNode
  emptyText?: string
}

const FILE_MENTION_KIND = 'file'

function toMentionItem(file: FileMention): MentionItem {
  return { id: file.path, label: file.name, detail: file.path, kind: FILE_MENTION_KIND }
}

function toFileMention(item: MentionItem): FileMention {
  return { path: item.id, name: item.label }
}

/**
 * Ranks `files` against `query` (case-insensitive), capped to `limit`:
 * name-prefix matches first, then name-substring, then path-substring.
 * Within a tier, shorter names sort first (the more specific match), then
 * alphabetically by path for a stable order. An empty query returns the
 * first `limit` entries unranked — the popover's default list before typing.
 * Pure and dependency-free (no fuzzy-match library) so it's cheap enough to
 * re-run on every keystroke against a 10k-entry index.
 */
export function rankFileMentions(
  files: readonly FileMention[],
  query: string,
  limit: number,
): FileMention[] {
  const q = query.trim().toLowerCase()
  if (!q) return files.slice(0, limit)
  const scored: Array<{ file: FileMention; tier: 0 | 1 | 2 }> = []
  for (const file of files) {
    const name = file.name.toLowerCase()
    if (name.startsWith(q)) {
      scored.push({ file, tier: 0 })
      continue
    }
    if (name.includes(q)) {
      scored.push({ file, tier: 1 })
      continue
    }
    if (file.path.toLowerCase().includes(q)) {
      scored.push({ file, tier: 2 })
    }
  }
  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    if (a.file.name.length !== b.file.name.length) return a.file.name.length - b.file.name.length
    return a.file.path.localeCompare(b.file.path)
  })
  return scored.slice(0, limit).map((s) => s.file)
}

type IndexState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; files: FileMention[]; truncated: boolean; fetchedAt: number }
  | { kind: 'warming'; attemptedAt: number }
  | { kind: 'error'; message: string; attemptedAt: number }

/** Minimum spacing between automatic retries while the box is warming or the
 *  last attempt errored — a query per keystroke would otherwise hammer the
 *  index endpoint the whole time the box is cold. */
const RETRY_AFTER_MS = 3000

export interface UseFileMentionsOptions {
  /** GET endpoint returning `FileIndexResponse` (a `createSandboxFileIndexRoute`). */
  indexUrl: string
  /** Max popover results per query. Default 20. */
  limit?: number
  /** How long a `ready` index is served without a background refetch.
   *  Default 5 minutes. */
  refreshAfterMs?: number
  /** `fetch` override for tests / non-global-fetch hosts. Default `fetch`. */
  fetchImpl?: typeof fetch
  /** Text shown in the popover's empty state once the index is loaded and
   *  the query matched nothing. Default "No matching files". */
  emptyText?: string
}

export interface UseFileMentionsResult {
  /** Spread straight into `AgentComposer`'s `mention` prop. */
  mention: ComposerMentionProp
  /** The files currently referenced by mentions in the composer's value —
   *  the send-body list (map through `fileMentionsToParts`). */
  mentions: FileMention[]
  /** Drop all currently-referenced mentions (e.g. after a successful send). */
  clearMentions: () => void
}

/** Never blocks — a `warming` or `error` index answers `fetchItems` with an
 *  empty list plus an explanatory `emptyText`, since the frozen composer
 *  contract has no separate loading/warming slot. */
function emptyTextFor(state: IndexState, fallback: string): string {
  switch (state.kind) {
    case 'idle':
    case 'loading':
      return 'Loading files…'
    case 'warming':
      return 'Sandbox is starting — try again in a moment'
    case 'error':
      return `Couldn't load files: ${state.message}`
    case 'ready':
      return fallback
  }
}

export function useFileMentions(options: UseFileMentionsOptions): UseFileMentionsResult {
  const { indexUrl, limit = 20, refreshAfterMs = 5 * 60 * 1000, emptyText = 'No matching files' } = options
  const fetchImpl = options.fetchImpl ?? fetch

  const [state, setState] = useState<IndexState>({ kind: 'idle' })
  // `fetchItems` needs the settled result of a fetch it just awaited, but a
  // `setState` call doesn't synchronously update anything a plain callback
  // can read — the re-render (and this ref's refresh) lands on a later tick.
  // `load()` returns its resolved `IndexState` directly (and mirrors it onto
  // this ref) so `fetchItems` never depends on render timing for its answer;
  // the ref separately lets `fetchItems` read the CURRENT state up front
  // without subscribing to it (which would break `mention`'s referential
  // stability on every keystroke).
  const stateRef = useRef(state)
  stateRef.current = state
  const inFlightRef = useRef<Promise<IndexState> | null>(null)
  const [mentions, setMentions] = useState<FileMention[]>([])

  const load = useCallback((): Promise<IndexState> => {
    if (inFlightRef.current) return inFlightRef.current
    if (stateRef.current.kind === 'idle') {
      stateRef.current = { kind: 'loading' }
      setState(stateRef.current)
    }
    const attempt = (async (): Promise<IndexState> => {
      let next: IndexState
      try {
        const res = await fetchImpl(indexUrl)
        if (!res.ok) {
          next = { kind: 'error', message: `HTTP ${res.status}`, attemptedAt: Date.now() }
        } else {
          const body = (await res.json()) as FileIndexResponse
          next =
            body.status === 'warming'
              ? { kind: 'warming', attemptedAt: Date.now() }
              : {
                  kind: 'ready',
                  files: (body as FileIndexReadyResponse).files,
                  truncated: (body as FileIndexReadyResponse).truncated,
                  fetchedAt: Date.now(),
                }
        }
      } catch (err) {
        next = { kind: 'error', message: err instanceof Error ? err.message : String(err), attemptedAt: Date.now() }
      }
      stateRef.current = next
      setState(next)
      inFlightRef.current = null
      return next
    })()
    inFlightRef.current = attempt
    return attempt
  }, [fetchImpl, indexUrl])

  const fetchItems = useCallback(
    async (query: string): Promise<MentionItem[]> => {
      let current = stateRef.current
      // First open: block on the fetch so the popover's first result set
      // reflects it. Once `ready`, background-refresh a stale cache without
      // blocking this query's answer. A warming/errored index retries at
      // most every RETRY_AFTER_MS — not on every keystroke.
      if (current.kind === 'idle' || current.kind === 'loading') {
        current = await load()
      } else if (current.kind === 'ready') {
        if (Date.now() - current.fetchedAt > refreshAfterMs) void load()
      } else if (Date.now() - current.attemptedAt > RETRY_AFTER_MS) {
        void load()
      }
      if (current.kind !== 'ready') return []
      return rankFileMentions(current.files, query, limit).map(toMentionItem)
    },
    [load, limit, refreshAfterMs],
  )

  const onMentionsChange = useCallback((items: MentionItem[]) => {
    setMentions(items.filter((item) => item.kind === undefined || item.kind === FILE_MENTION_KIND).map(toFileMention))
  }, [])

  const clearMentions = useCallback(() => setMentions([]), [])

  const mention = useMemo<ComposerMentionProp>(
    () => ({
      fetchItems,
      onMentionsChange,
      emptyText: emptyTextFor(state, emptyText),
    }),
    [fetchItems, onMentionsChange, state, emptyText],
  )

  return { mention, mentions, clearMentions }
}
