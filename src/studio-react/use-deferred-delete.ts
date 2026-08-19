import { useCallback, useEffect, useRef, useState } from 'react'

import type { Generation } from '../studio/generation'
import type { DeleteGenerations } from '../studio/ports'
import { useStudioPlayback } from './studio-playback'
import { useStudioToast } from './studio-toasts'

export interface UseDeferredDeleteOptions {
  remove: DeleteGenerations
  /** Undo window AND toast lifetime. Default 3500. */
  undoWindowMs?: number
  /** After the server call succeeds for a batch. */
  onCommitted?: (ids: readonly string[]) => void
  /** After a failed server call restored the rows (screens may refetch). */
  onRestoreFailed?: (ids: readonly string[]) => void
}

export interface DeferredDelete {
  /** Rows the screens must filter OUT of every render. Survives refetches. */
  pendingIds: ReadonlySet<string>
  request: (generations: readonly Generation[]) => void
  /** Commit every outstanding batch NOW (unmount/navigation). */
  flush: () => void
}

interface DeleteBatch {
  ids: readonly string[]
  toastId: string
  status: 'pending' | 'committing'
}

const itemLabel = (count: number) => `item${count === 1 ? '' : 's'}`

export function useDeferredDelete(options: UseDeferredDeleteOptions): DeferredDelete {
  const { activeId, stop } = useStudioPlayback()
  const { dismiss, toast } = useStudioToast()
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set())
  const batchesRef = useRef(new Map<string, DeleteBatch>())
  const committedIdsRef = useRef(new Set<string>())
  const sequenceRef = useRef(0)
  const optionsRef = useRef(options)
  const dismissRef = useRef(dismiss)
  optionsRef.current = options
  dismissRef.current = dismiss

  const visiblePendingIds = useCallback(() => {
    const ids = new Set(committedIdsRef.current)
    for (const batch of batchesRef.current.values()) {
      for (const id of batch.ids) ids.add(id)
    }
    return ids
  }, [])

  const commit = useCallback((batchKey: string) => {
    const batch = batchesRef.current.get(batchKey)
    if (!batch || batch.status !== 'pending') return
    batch.status = 'committing'

    void optionsRef.current.remove(batch.ids).then(() => {
      if (batchesRef.current.get(batchKey) !== batch) return
      batchesRef.current.delete(batchKey)
      for (const id of batch.ids) committedIdsRef.current.add(id)
      optionsRef.current.onCommitted?.(batch.ids)
    }, () => {
      if (batchesRef.current.get(batchKey) !== batch) return
      batchesRef.current.delete(batchKey)
      setPendingIds(visiblePendingIds())
      toast({ message: `Could not delete ${batch.ids.length} ${itemLabel(batch.ids.length)}` })
      optionsRef.current.onRestoreFailed?.(batch.ids)
    })
  }, [toast, visiblePendingIds])

  const request = useCallback((generations: readonly Generation[]) => {
    if (generations.length === 0) return
    const ids = [...new Set(generations.map((generation) => generation.id))]
    const batchKey = `deferred-delete-${++sequenceRef.current}`

    setPendingIds((current) => {
      const next = new Set(current)
      for (const id of ids) next.add(id)
      return next
    })
    if (activeId && ids.includes(activeId)) stop()

    const undo = () => {
      const batch = batchesRef.current.get(batchKey)
      if (!batch || batch.status !== 'pending') return
      batchesRef.current.delete(batchKey)
      setPendingIds(visiblePendingIds())
      toast({ message: `Restored ${ids.length} ${itemLabel(ids.length)}` })
    }

    const toastId = toast({
      message: `Deleted ${ids.length} ${itemLabel(ids.length)}`,
      action: { label: 'Undo', run: undo },
      durationMs: options.undoWindowMs ?? 3500,
      onDismiss: (reason) => {
        if (reason !== 'action') commit(batchKey)
      },
    })
    batchesRef.current.set(batchKey, { ids, toastId, status: 'pending' })
  }, [activeId, commit, options.undoWindowMs, stop, toast, visiblePendingIds])

  const flush = useCallback(() => {
    for (const [batchKey, batch] of batchesRef.current) {
      if (batch.status !== 'pending') continue
      batch.status = 'committing'
      batchesRef.current.delete(batchKey)
      dismissRef.current(batch.toastId)
      void optionsRef.current.remove(batch.ids).catch(() => {})
    }
  }, [])

  useEffect(() => {
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [flush])

  return { pendingIds, request, flush }
}
