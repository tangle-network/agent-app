import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRevalidator } from 'react-router'
import {
  type Generation,
  generationMergeKey,
  generationStatus,
  isLocalGeneration,
  latestBatchOf,
  mergeLiveGeneration,
} from '../studio'

/**
 * The generation orchestrator behind a studio surface: it merges the loader's
 * rows with in-flight live generations, computes the latest batch for the
 * canvas, polls running generations until they settle, and revalidates the
 * route loader when a status changes.
 *
 * The merge keeps the canvas, the library, and the polling path looking at the
 * same full list. Polling hits `generationsEndpoint` (default `/api/generations`,
 * the convention both apps already serve); pass an override if a product routes
 * it elsewhere. `onGenerated` is wired to the composer's per-result callback.
 */
export function useStudioGenerations(
  loaderGenerations: Generation[],
  options: { workspaceId?: string; generationsEndpoint?: string } = {},
) {
  const { workspaceId, generationsEndpoint = '/api/generations' } = options
  const revalidator = useRevalidator()
  const [liveGenerations, setLiveGenerations] = useState<Generation[]>([])

  const mergedGenerations = useMemo(() => {
    if (liveGenerations.length === 0) return loaderGenerations
    const leadingGenerations = liveGenerations.map((generation) => {
      const mergeKey = generationMergeKey(generation)
      return mergeKey
        ? loaderGenerations.find((gen) => generationMergeKey(gen) === mergeKey) ?? generation
        : loaderGenerations.find((gen) => gen.id === generation.id) ?? generation
    })
    const leadingIds = new Set(leadingGenerations.map((gen) => gen.id))
    const leadingMergeKeys = new Set(leadingGenerations
      .map((gen) => generationMergeKey(gen))
      .filter((id): id is string => Boolean(id)))
    return [
      ...leadingGenerations,
      ...loaderGenerations.filter((gen) => (
        !leadingIds.has(gen.id)
        && !leadingMergeKeys.has(generationMergeKey(gen) ?? '')
      )),
    ]
  }, [loaderGenerations, liveGenerations])

  const latestBatch = useMemo(() => latestBatchOf(mergedGenerations), [mergedGenerations])

  const runningGenerationIds = useMemo(() => mergedGenerations
    .filter((gen) => {
      const status = generationStatus(gen)
      return status === 'pending' || status === 'running'
    })
    .map((gen) => gen.id)
    .filter((id) => !id.startsWith('local-')), [mergedGenerations])

  useEffect(() => {
    if (!workspaceId || runningGenerationIds.length === 0) return
    let cancelled = false
    const poll = async () => {
      const responses = await Promise.all(runningGenerationIds.map(async (id) => {
        const res = await fetch(`${generationsEndpoint}?workspaceId=${encodeURIComponent(workspaceId)}&id=${encodeURIComponent(id)}`)
        if (!res.ok) return null
        const data = await res.json() as { generation?: Generation }
        return data.generation ?? null
      }))
      if (cancelled) return
      const refreshed = responses.filter((gen): gen is Generation => Boolean(gen))
      if (refreshed.length > 0) {
        setLiveGenerations((current) => refreshed.reduce(mergeLiveGeneration, current))
      }
      if (refreshed.some((gen) => generationStatus(gen) !== 'running' && generationStatus(gen) !== 'pending')) {
        revalidator.revalidate()
      }
    }
    const interval = window.setInterval(() => { void poll() }, 4_000)
    void poll()
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [revalidator, runningGenerationIds, workspaceId, generationsEndpoint])

  const onGenerated = useCallback((generation: Generation) => {
    setLiveGenerations((current) => mergeLiveGeneration(current, generation))
    if (!isLocalGeneration(generation)) revalidator.revalidate()
  }, [revalidator])

  return { mergedGenerations, latestBatch, onGenerated }
}
