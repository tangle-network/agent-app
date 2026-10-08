/**
 * The files a reader opened most recently in this browser, per vault scope
 * (`treeStateKey`). Storage can be blocked or full; every access degrades to
 * an empty list rather than failing the pane.
 */

const PREFIX = 'tangle:vault-recent:'
/** How many paths are kept; the empty state shows a few of them. */
const RECENT_FILE_LIMIT = 8

function storage(key: string | undefined): Storage | null {
  if (!key || typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readRecentFiles(key: string | undefined): string[] {
  const store = storage(key)
  if (!store) return []
  try {
    const parsed: unknown = JSON.parse(store.getItem(PREFIX + key) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** Moves `path` to the front and returns the new list. */
export function recordRecentFile(key: string | undefined, path: string): string[] {
  const next = [path, ...readRecentFiles(key).filter((item) => item !== path)].slice(0, RECENT_FILE_LIMIT)
  const store = storage(key)
  if (store) {
    try {
      store.setItem(PREFIX + key, JSON.stringify(next))
    } catch {
      // Full or blocked storage: the list lives for this render only.
    }
  }
  return next
}
