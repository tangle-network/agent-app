/**
 * The media model catalog a product's picker and admission checks read: image,
 * speech and transcription models from the Router's general catalog (by
 * endpoint routeability), video and avatar models from its video catalog,
 * sorted with the product's default first and cached per base URL. What a
 * routeability result or a video model's health means for admission, and any
 * extra picker fields, are the product's policy, passed in as callbacks.
 */
import type { GenerationType, MediaModelStatus } from '../studio/generation'
import { routerResponseErrorMessage, routerV1Url } from './router-client'

export type MediaRouteabilityEndpoint = 'images_generations' | 'images_edits' | 'audio_speech' | 'audio_transcriptions'

/** A model row of the Router's general catalog, as far as media admission reads it. */
export interface RouterMediaModelRow {
  id?: unknown
  name?: unknown
  _provider?: unknown
  provider?: unknown
  architecture?: { input_modalities?: unknown[]; output_modalities?: unknown[] }
  supported_parameters?: unknown[]
  routeability?: {
    endpoints?: Partial<Record<MediaRouteabilityEndpoint, { routeable?: unknown; status?: unknown; reason?: unknown }>>
  }
  [field: string]: unknown
}

/** A model row of the Router's video catalog. */
export interface RouterVideoModelRow {
  id?: unknown
  name?: unknown
  provider?: unknown
  capability?: unknown
  available?: unknown
  configured?: unknown
  supported_parameters?: unknown[]
  input_modalities?: unknown[]
  output_modalities?: unknown[]
  [field: string]: unknown
}

/** One selectable model: what every product's catalog row carries. */
export interface MediaCatalogModel {
  id: string
  name: string
  provider?: string
  type: GenerationType
  status: MediaModelStatus
  reason?: string
  routeable?: boolean
  configured?: boolean
  available?: boolean
  supportedParameters?: string[]
  inputModalities?: string[]
  outputModalities?: string[]
  source: 'models' | 'videos'
}

export interface MediaCatalog<M extends MediaCatalogModel> {
  defaults: Record<GenerationType, string>
  models: Record<GenerationType, M[]>
}

/** How a product reads one model's availability. */
export interface MediaModelAdmission {
  status: MediaModelStatus
  reason?: string
  routeable: boolean
}

export interface MediaModelCatalogConfig<Extra extends object> {
  defaults: Record<GenerationType, string>
  /** The operator-configured router base URL. */
  routerBaseUrl: () => string
  /** The general model catalog: the public one, or the key owner's when a key is given. */
  fetchRouterModels: (routerBaseUrl: string, apiKey?: string) => Promise<readonly RouterMediaModelRow[]>
  /** Admission of a model from its routeability result on one endpoint. */
  routeability: (endpointStatus: { routeable?: unknown; status?: unknown }) => Pick<MediaModelAdmission, 'status' | 'reason'>
  /** Admission of a video or avatar model from its video-catalog row. */
  videoAdmission: (model: RouterVideoModelRow, type: 'video' | 'avatar') => MediaModelAdmission
  /** Product fields added to each row, from the raw catalog row and its declared input modalities. */
  extraFields?: (row: RouterMediaModelRow | RouterVideoModelRow, type: GenerationType, inputModalities: string[]) => Extra
  cacheTtlMs?: number
}

const DEFAULT_CACHE_TTL_MS = 300_000

const ENDPOINT_BY_TYPE = {
  image: 'images_generations',
  speech: 'audio_speech',
  transcription: 'audio_transcriptions',
} as const

export function createMediaModelCatalog<Extra extends object = Record<never, never>>(config: MediaModelCatalogConfig<Extra>) {
  type Model = MediaCatalogModel & Extra
  let cache: { routerBaseUrl: string; expiresAt: number; value: MediaCatalog<Model> } | null = null

  function modelFromRouteability(
    model: RouterMediaModelRow,
    type: 'image' | 'speech' | 'transcription',
    endpoint: MediaRouteabilityEndpoint = ENDPOINT_BY_TYPE[type],
  ): Model | null {
    const id = stringValue(model.id)
    if (!id) return null
    const endpointStatus = model.routeability?.endpoints?.[endpoint]
    if (!endpointStatus) return null

    const admission = config.routeability(endpointStatus)
    const inputModalities = stringArray(model.architecture?.input_modalities)
    return {
      id,
      name: stringValue(model.name) ?? id,
      provider: stringValue(model._provider) ?? stringValue(model.provider),
      type,
      status: admission.status,
      reason: admission.reason,
      routeable: endpointStatus.routeable === true,
      inputModalities,
      outputModalities: stringArray(model.architecture?.output_modalities),
      supportedParameters: stringArray(model.supported_parameters),
      source: 'models',
      ...config.extraFields?.(model, type, inputModalities),
    } as Model
  }

  function modelFromVideoCatalog(model: RouterVideoModelRow, type: 'video' | 'avatar'): Model | null {
    const id = stringValue(model.id)
    if (!id) return null
    const admission = config.videoAdmission(model, type)
    const inputModalities = stringArray(model.input_modalities)
    return {
      id,
      name: stringValue(model.name) ?? id,
      provider: stringValue(model.provider),
      type,
      status: admission.status,
      reason: admission.reason,
      routeable: admission.routeable,
      configured: model.configured === true,
      available: model.available === true,
      supportedParameters: stringArray(model.supported_parameters),
      inputModalities,
      outputModalities: stringArray(model.output_modalities),
      source: 'videos',
      ...config.extraFields?.(model, type, inputModalities),
    } as Model
  }

  async function buildMediaModelCatalog(
    routerBaseUrl = config.routerBaseUrl(),
    routerApiKey?: string,
  ): Promise<MediaCatalog<Model>> {
    const normalizedBaseUrl = routerBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
    const now = Date.now()
    if (!routerApiKey && cache && cache.routerBaseUrl === normalizedBaseUrl && cache.expiresAt > now) {
      return cache.value
    }

    const [generalModels, videoModels] = await Promise.all([
      config.fetchRouterModels(normalizedBaseUrl, routerApiKey),
      fetchVideoModels(normalizedBaseUrl),
    ])
    const { defaults } = config
    const fromGeneral = (type: 'image' | 'speech' | 'transcription') => sortMediaModels(
      generalModels.map((model) => modelFromRouteability(model, type)).filter((model): model is Model => Boolean(model)),
      defaults[type],
    )
    const fromVideo = (type: 'video' | 'avatar', capability: string) => sortMediaModels(
      videoModels
        .filter((model) => stringValue(model.capability) === capability)
        .map((model) => modelFromVideoCatalog(model, type))
        .filter((model): model is Model => Boolean(model)),
      defaults[type],
    )

    const catalog: MediaCatalog<Model> = {
      defaults,
      models: {
        image: fromGeneral('image'),
        speech: fromGeneral('speech'),
        transcription: fromGeneral('transcription'),
        video: fromVideo('video', 'generate'),
        avatar: fromVideo('avatar', 'avatar'),
      },
    }

    if (!routerApiKey) {
      cache = { routerBaseUrl: normalizedBaseUrl, expiresAt: now + (config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS), value: catalog }
    }
    return catalog
  }

  /** Admit the model a request names for `type`, from the catalog the key (or the public catalog) sees. */
  async function validateMediaModelSelection(type: GenerationType, modelId: string, routerApiKey?: string) {
    return checkMediaModelSelection(modelId, `${type} generation`, async (id) => {
      const catalog = await buildMediaModelCatalog(config.routerBaseUrl(), routerApiKey)
      return catalog.models[type].find((option) => option.id === id)
    })
  }

  return {
    buildMediaModelCatalog,
    validateMediaModelSelection,
    modelFromRouteability,
    clearMediaModelCatalogCache: () => { cache = null },
  }
}

/**
 * Admit one model for `purpose`: the id must be given, listed by `lookup`, and
 * not unavailable. A failure names the purpose and the model's own reason.
 */
export async function checkMediaModelSelection<M extends MediaCatalogModel>(
  modelId: string,
  purpose: string,
  lookup: (id: string) => Promise<M | null | undefined>,
): Promise<{ succeeded: true; value: M } | { succeeded: false; error: string }> {
  const id = modelId.trim()
  if (!id) return { succeeded: false, error: `model is required for ${purpose}` }
  const model = await lookup(id)
  if (!model) return { succeeded: false, error: `Model "${id}" is not available for ${purpose}` }
  if (model.status === 'unavailable') {
    return {
      succeeded: false,
      error: `Model "${id}" is unavailable for ${purpose}${model.reason ? `: ${model.reason}` : ''}`,
    }
  }
  return { succeeded: true, value: model }
}

async function fetchVideoModels(routerBaseUrl: string): Promise<RouterVideoModelRow[]> {
  const response = await fetch(`${routerV1Url(routerBaseUrl)}/videos/models`)
  if (!response.ok) {
    throw new Error(`Could not load video models: ${response.status} ${await routerResponseErrorMessage(response)}`)
  }
  const data = await response.json() as { data?: RouterVideoModelRow[] }
  return Array.isArray(data.data) ? data.data : []
}

function sortMediaModels<M extends MediaCatalogModel>(models: M[], preferredId: string): M[] {
  const statusWeight: Record<MediaModelStatus, number> = { available: 0, limited: 1, unavailable: 2 }
  return [...models].sort((a, b) => {
    if (a.id === preferredId) return -1
    if (b.id === preferredId) return 1
    const statusDiff = statusWeight[a.status] - statusWeight[b.status]
    if (statusDiff !== 0) return statusDiff
    return a.id.localeCompare(b.id)
  })
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
