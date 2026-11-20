import { useCallback, useMemo, useSyncExternalStore } from 'react'

/** An inactive query uses its fallback without registering a listener. */
export function useMediaQuery(query: string | undefined, fallback = true): boolean {
  const media = useMemo(
    () => query && typeof window !== 'undefined' ? window.matchMedia?.(query) : undefined,
    [query],
  )
  const subscribe = useCallback((notify: () => void) => {
    media?.addEventListener('change', notify)
    return () => media?.removeEventListener('change', notify)
  }, [media])
  return useSyncExternalStore(subscribe, () => media?.matches ?? fallback, () => fallback)
}
