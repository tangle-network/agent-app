/** Name filtering and cancellable, debounced file-content search. */
import { useEffect, useMemo, useState } from 'react'
import { filterFileNodes } from '@tangle-network/sandbox-ui/vault-tree'
import type { VaultDataPort, VaultTreeNode } from './contracts'
import type { ContentSearchState } from './VaultContentResults'
import { operationMessage } from './VaultPaneStates'

/** Characters a content search needs before it asks the port. */
const CONTENT_SEARCH_MIN = 2
/** Pause after the last keystroke before a content search is sent. */
const CONTENT_SEARCH_DEBOUNCE_MS = 250

export function useVaultSearch({ port, treeRoot }: { port: Pick<VaultDataPort, 'searchContent'>; treeRoot: VaultTreeNode }) {
  const [query, setQuery] = useState('')
  const [contentSearch, setContentSearch] = useState<ContentSearchState>({ status: 'idle' })
  const [contentSearchNonce, setContentSearchNonce] = useState(0)
  // Search always covers the whole vault. Expanding a folder makes it the
  // active folder, and a search silently narrowed to it hid files the reader
  // was looking for; the active folder only decides where a new file goes.
  const visibleRoot = useMemo<VaultTreeNode>(() => {
    const q = query.trim().toLowerCase()
    if (!q) return treeRoot
    return { ...treeRoot, children: filterFileNodes(treeRoot.children ?? [], q) }
  }, [treeRoot, query])

  // Words inside files, from the port, a moment after the reader stops typing.
  const searchQuery = query.trim()
  const canSearchContent = typeof port.searchContent === 'function'
  useEffect(() => {
    if (!canSearchContent || searchQuery.length < CONTENT_SEARCH_MIN) {
      setContentSearch({ status: 'idle' })
      return
    }
    const controller = new AbortController()
    setContentSearch((current) => ({
      status: 'loading',
      query: searchQuery,
      matches: current.status !== 'idle' && current.status !== 'error' && current.query === searchQuery ? current.matches : [],
    }))
    const timer = setTimeout(() => {
      port.searchContent!(searchQuery, { signal: controller.signal }).then(
        (matches) => {
          if (!controller.signal.aborted) setContentSearch({ status: 'done', query: searchQuery, matches })
        },
        (error) => {
          if (!controller.signal.aborted) {
            setContentSearch({ status: 'error', query: searchQuery, message: operationMessage(error, 'The search did not answer.') })
          }
        },
      )
    }, CONTENT_SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [port, canSearchContent, searchQuery, contentSearchNonce])
  // Until the effect catches up with a new query, its results are pending, not empty.
  const contentResults: ContentSearchState = !canSearchContent || searchQuery.length < CONTENT_SEARCH_MIN
    ? { status: 'idle' }
    : contentSearch.status !== 'idle' && contentSearch.query === searchQuery
      ? contentSearch
      : { status: 'loading', query: searchQuery, matches: [] }

  return { query, onQueryChange: setQuery, visibleRoot, canSearchContent, contentResults, retry: () => setContentSearchNonce((n) => n + 1) }
}
