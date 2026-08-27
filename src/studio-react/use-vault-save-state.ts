import { useCallback, useMemo, useState } from 'react'

import type { Generation } from '../studio/generation'
import type { VaultSaveResult } from '../studio/ports'

/** Overlay successful save results without waiting for the host's next loader
 *  refresh. Every Studio screen owns a different row source, so this small
 *  id-keyed overlay keeps tiles, viewers, and history batch actions coherent. */
export function useVaultSaveState(generations: readonly Generation[]) {
  const [results, setResults] = useState<ReadonlyMap<string, VaultSaveResult>>(() => new Map())

  const savedGenerations = useMemo(() => generations.map((generation) => {
    const result = results.get(generation.id)
    if (!result) return generation
    return {
      ...generation,
      metadata: {
        ...generation.metadata,
        vaultPath: result.vaultPath,
        savedToVaultAt: result.savedToVaultAt ?? true,
      },
    }
  }), [generations, results])

  const applySaveResults = useCallback((saved: readonly VaultSaveResult[]) => {
    if (saved.length === 0) return
    setResults((current) => {
      const next = new Map(current)
      for (const result of saved) next.set(result.generationId, result)
      return next
    })
  }, [])

  return { generations: savedGenerations, applySaveResults }
}
