import { useEffect, useRef, useState } from 'react'
import type { ModelInfo } from '@tangle-network/sandbox-ui/dashboard'
import type { CatalogModel } from '../catalog/index'

/** Options for the model-catalog hook. */
export interface UseModelsOptions {
  /** False skips the fetch (e.g. a signed-out view). */
  enabled?: boolean
  /** Catalog route; defaults to `/api/models`. Prefix it for a split API origin. */
  url?: string
}

/** The model catalog for a product's pickers. */
export interface UseModelsResult {
  models: ModelInfo[]
  /** Picker-ready list from the shared filter/dedupe/rank pipeline, built server-side. */
  catalog: CatalogModel[]
  loading: boolean
  error: string | null
  reload: () => void
}

interface ModelCacheEntry { fetchedAt: number; data: ModelInfo[]; catalog: CatalogModel[] }

const modelCache = new Map<string, ModelCacheEntry>()
const STALE_AFTER_MS = 10 * 60 * 1000

/**
 * Load the model catalog (`{ data, catalog }`) from the product's models
 * route. An in-memory cache per URL keeps later picker mounts instant within
 * the page session; entries older than ten minutes refetch.
 */
export function useModels(options: UseModelsOptions = {}): UseModelsResult {
  const { enabled = true, url = '/api/models' } = options
  const cached = modelCache.get(url)
  const [models, setModels] = useState<ModelInfo[]>(cached?.data ?? [])
  const [catalog, setCatalog] = useState<CatalogModel[]>(cached?.catalog ?? [])
  const [loading, setLoading] = useState(enabled && !cached)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  // A reload bypasses the cache once; later url or enabled changes read it again.
  const forceFetch = useRef(false)

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    const entry = modelCache.get(url)
    const force = forceFetch.current
    forceFetch.current = false
    if (entry && Date.now() - entry.fetchedAt < STALE_AFTER_MS && !force) {
      setModels(entry.data)
      setCatalog(entry.catalog)
      setError(null)
      // A switch from a URL still fetching cancels that fetch, so this branch ends the load.
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    // Never show another URL's catalog while this one loads; a reload keeps the current list.
    if (!entry) {
      setModels([])
      setCatalog([])
    }

    fetch(url, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${url} returned ${res.status}`)
        return res.json() as Promise<{ data?: ModelInfo[]; catalog?: CatalogModel[] }>
      })
      .then((body) => {
        if (cancelled) return
        const data = Array.isArray(body.data) ? body.data : []
        const catalogList = Array.isArray(body.catalog) ? body.catalog : []
        modelCache.set(url, { fetchedAt: Date.now(), data, catalog: catalogList })
        setModels(data)
        setCatalog(catalogList)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load models')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [enabled, url, reloadKey])

  return {
    models,
    catalog,
    loading,
    error,
    reload: () => {
      forceFetch.current = true
      setReloadKey((key) => key + 1)
    },
  }
}
