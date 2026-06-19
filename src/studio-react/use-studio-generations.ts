import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRevalidator } from 'react-router'
import {
  type Generation,
  generationStatus,
  isLocalGeneration,
  latestBatchOf,
  mergeLiveGeneration,
  mergeLoaderAndLive,
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

  const mergedGenerations = useMemo(
    () => mergeLoaderAndLive(loaderGenerations, liveGenerations),
    [loaderGenerations, liveGenerations],
  )

  const latestBatch = useMemo(() => latestBatchOf(mergedGenerations), [mergedGenerations])

  const runningGenerationIds = useMemo(() => mergedGenerations
    .filter((gen) => {
      const status = generationStatus(gen)
      return status === 'pending' || status === 'running'
    })
    .map((gen) => gen.id)
    .filter((id) => !id.startsWith('local-')), [mergedGenerations])

  // The poll loop must not churn the effect. `runningGenerationIds` is a fresh
  // array every render and react-router's `revalidator` identity flips while a
  // revalidation is in flight — depending on either restarts the interval on
  // every tick, collapsing the 4s cadence into a request flood. Key the effect
  // on the STABLE join of the running ids (re-subscribe only when the set
  // actually changes) and reach the live ids / revalidate through refs.
  const runningIdsRef = useRef(runningGenerationIds)
  runningIdsRef.current = runningGenerationIds
  const revalidateRef = useRef(revalidator.revalidate)
  revalidateRef.current = revalidator.revalidate
  const runningKey = runningGenerationIds.join(',')

  useEffect(() => {
    if (!workspaceId || !runningKey) return
    let cancelled = false
    const poll = async () => {
      const responses = await Promise.all(runningIdsRef.current.map(async (id) => {
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
        revalidateRef.current()
      }
    }
    const interval = window.setInterval(() => { void poll() }, 4_000)
    void poll()
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [runningKey, workspaceId, generationsEndpoint])

  const onGenerated = useCallback((generation: Generation) => {
    setLiveGenerations((current) => mergeLiveGeneration(current, generation))
    if (!isLocalGeneration(generation)) revalidateRef.current()
  }, [])

  return { mergedGenerations, latestBatch, onGenerated }
}
