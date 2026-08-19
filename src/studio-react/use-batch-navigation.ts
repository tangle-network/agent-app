import { useCallback, useRef } from 'react'
import { generationBatchKey, type Generation } from '../studio/generation'

export interface UseBatchNavigationOptions {
  /** Rows whose batch keys are treated as already seen. Read once, at mount. */
  seed: readonly Generation[]
  /**
   * A batch key that never navigates, read on every call — the generation
   * screen passes its own batch so rows landing for the batch already on
   * screen stay put while a NEW dock submit navigates.
   */
  currentBatchKey?: string
  onOpenGeneration: (batchKey: string, first: Generation) => void
}

/**
 * Returns a callback the screens wrap around `onGenerated`: the first row of a
 * batch not seen before navigates via `onOpenGeneration`, exactly once per
 * batch — a four-image batch arrives as four rows sharing one batch key and
 * must produce one navigation, and rows merely refreshed from the loader
 * (seeded at mount) must produce none.
 */
export function useBatchNavigation({
  seed,
  currentBatchKey,
  onOpenGeneration,
}: UseBatchNavigationOptions): (generation: Generation) => void {
  const seenKeys = useRef<Set<string> | null>(null)
  seenKeys.current ??= new Set(seed.map(generationBatchKey))
  const currentRef = useRef(currentBatchKey)
  currentRef.current = currentBatchKey

  return useCallback((generation: Generation) => {
    const key = generationBatchKey(generation)
    const seen = seenKeys.current
    if (key === currentRef.current || !seen || seen.has(key)) return
    seen.add(key)
    onOpenGeneration(key, generation)
  }, [onOpenGeneration])
}
