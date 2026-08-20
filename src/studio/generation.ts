import type { ModelOptionsMetadata } from './model-options'

/** Define generation categories for media including image, video, speech, avatar, and transcription */
export type GenerationType = 'image' | 'video' | 'speech' | 'avatar' | 'transcription'

/** Define possible states representing the progress of a generation process */
export type GenerationStatus = 'pending' | 'running' | 'succeeded' | 'failed'

/** Define possible status values for a media model's availability and accessibility */
export type MediaModelStatus = 'available' | 'limited' | 'unavailable'

/** Define the structure for a generation entity including its metadata and creation details */
export interface Generation {
  id: string
  type: string
  prompt: string
  result: string | null
  model: string | null
  cost: number | null
  createdAt: Date | null
  metadata: Record<string, unknown> | null
}

/** Describe a catalog media model and its optional wire-level option metadata. */
export interface MediaModelOption {
  id: string
  name: string
  provider?: string
  type: GenerationType
  status: MediaModelStatus
  reason?: string
  options?: ModelOptionsMetadata
}

/** Represent media model catalog with default values, model options, and optional error message */
export interface MediaModelCatalogResponse {
  defaults: Record<GenerationType, string>
  models: Record<GenerationType, MediaModelOption[]>
  error?: string
}

// Order drives the library type filter tabs. The composer offers its own
// subset (`COMPOSER_TYPES` in studio-react) while avatar/transcription are
// disabled (#451).
/** Provide an array of supported generation types for media and content processing */
export const GENERATION_TYPES: readonly GenerationType[] = ['image', 'video', 'avatar', 'speech', 'transcription']

/** Resolve whether a string value matches a valid GenerationType */
export function isGenerationType(value: string): value is GenerationType {
  return (GENERATION_TYPES as readonly string[]).includes(value)
}

/** Define the minimum number of images required for processing or validation */
export const MIN_IMAGE_COUNT = 1
/** Define the maximum number of images allowed for upload or display */
export const MAX_IMAGE_COUNT = 8

/** Resolve a human-readable relative time string from a given date or return an empty string if null */
export function relativeTime(date: Date | null): string {
  if (!date) return ''
  const now = Date.now()
  const diff = now - new Date(date).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Resolve the output directory path based on the specified generation type */
export function outputPathFor(type: GenerationType): string {
  if (type === 'image') return 'generated/images'
  if (type === 'video') return 'generated/videos'
  if (type === 'avatar') return 'generated/avatars'
  if (type === 'speech') return 'generated/audio'
  return 'generated/transcripts'
}

/** Resolve the vault path string from a Generation object or return null if unavailable */
export function generationVaultPath(generation: Generation): string | null {
  const value = generation.metadata?.vaultPath
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** DEPRECATED (orphaned since #449 deleted its consumer) — resolve selected models by applying catalog defaults.
 *  @deprecated Orphaned since its consumer (the pre-revamp ComposerHero) was deleted in #449;
 *  the composer re-derives the guard over curated models inline. Kept for external consumers;
 *  removal is a breaking change. */
export function selectedModelsWithDefaults(
  current: Partial<Record<GenerationType, string>>,
  catalog: MediaModelCatalogResponse,
): Partial<Record<GenerationType, string>> {
  const next = { ...current }
  for (const key of GENERATION_TYPES) {
    const models = catalog.models[key] ?? []
    const currentOption = models.find((model) => model.id === next[key])
    // Reset when: no selection, selection not in catalog, or selection is unavailable.
    // This ensures the Generate button is never stuck disabled when routeable
    // models exist but the stored default isn't one of them.
    if (!next[key] || !currentOption || currentOption.status === 'unavailable') {
      next[key] = preferredModelId(key, catalog) ?? ''
    }
  }
  return next
}

/** Resolve the preferred model ID for a given generation type from the media model catalog */
export function preferredModelId(type: GenerationType, catalog: MediaModelCatalogResponse | null): string | undefined {
  if (!catalog) return undefined
  const models = catalog.models[type] ?? []
  const preferred = catalog.defaults[type]
  return models.find((model) => model.id === preferred && model.status !== 'unavailable')?.id
    ?? models.find((model) => model.status !== 'unavailable')?.id
    ?? models[0]?.id
}

/** True when a model list offers nothing sendable: no models, or every model unavailable. */
export function laneUnavailable(models: readonly MediaModelOption[]): boolean {
  return models.length === 0 || models.every((model) => model.status === 'unavailable')
}

/** DEPRECATED (the composer renders availability in the pill/menu/lane states since #463) — resolve the status message for a media model.
 *  @deprecated The composer no longer renders an availability status line (#463) — availability is
 *  carried by the model pill, the menu rows, and the lane-down notice. Kept only for external
 *  consumers; removal is a breaking change. */
export function modelMessage(model: MediaModelOption | undefined, loading: boolean, count: number): string | null {
  if (loading) return 'Loading media models...'
  if (count === 0) return 'No models are available for this media type.'
  if (!model) return 'Select a model.'
  if (model.status === 'unavailable') return model.reason ?? 'This model is not configured.'
  if (model.status === 'limited') return model.reason ? `Limited: ${model.reason}` : 'Limited availability.'
  return null
}

/** Define fields required to configure and request various types of media generation */
export interface GenerationRequestFields {
  workspaceId: string
  clientRequestId: string
  type: GenerationType
  model: string
  prompt: string
  // Every per-lane parameter except the image COUNT is optional, because the
  // composer only sends what the selected model publishes: a model whose
  // metadata omits `size` (or marks it `supported: false`) must send no `size`
  // at all, and a model that publishes nothing — `ltx-video` — sends only the
  // prompt. `count` stays required: it is the number of optimistic cards the
  // caller already drew, not a model parameter.
  image: { size?: string; quality?: string; count: number }
  video: {
    duration?: string | number
    resolution?: string
    aspectRatio?: string
    referenceImageUrl?: string
    audio?: boolean
    mode?: string
  }
  speech: { voice?: string; speed?: number }
  // Optional while the composer lanes are disabled (#451); the server capability stays.
  avatar?: { audioUrl: string; imageUrl: string; avatarId: string }
  transcription?: { audioUrl: string; language: string; responseFormat: string; temperature: string }
}

// image.count must already be normalized — it is also the optimistic-card count on the caller side
/** Build the request body object for a generation operation from provided fields */
export function buildGenerationRequestBody(fields: GenerationRequestFields): Record<string, unknown> {
  const body: Record<string, unknown> = {
    workspaceId: fields.workspaceId,
    clientRequestId: fields.clientRequestId,
    type: fields.type,
    model: fields.model,
    prompt: fields.prompt.trim(),
  }
  if (fields.type === 'image') {
    if (fields.image.size) body.size = fields.image.size
    if (fields.image.quality) body.quality = fields.image.quality
    body.n = fields.image.count
  }
  if (fields.type === 'video') {
    if (fields.video.duration !== undefined) body.duration = fields.video.duration
    if (fields.video.resolution) body.resolution = fields.video.resolution
    if (fields.video.aspectRatio) body.aspectRatio = fields.video.aspectRatio
    if (fields.video.referenceImageUrl) body.referenceImageUrl = fields.video.referenceImageUrl
    if (fields.video.audio !== undefined) body.audio = fields.video.audio
    if (fields.video.mode) body.mode = fields.video.mode
  }
  if (fields.type === 'speech') {
    if (fields.speech.voice) body.voice = fields.speech.voice
    if (fields.speech.speed !== undefined) body.speed = fields.speech.speed
  }
  if (fields.type === 'avatar' && fields.avatar) Object.assign(body, {
    audioUrl: fields.avatar.audioUrl.trim(),
    imageUrl: fields.avatar.imageUrl.trim() || undefined,
    avatarId: fields.avatar.avatarId.trim() || undefined,
  })
  if (fields.type === 'transcription' && fields.transcription) {
    const temperature = Number(fields.transcription.temperature)
    Object.assign(body, {
      audioUrl: fields.transcription.audioUrl.trim(),
      language: fields.transcription.language.trim() || undefined,
      responseFormat: fields.transcription.responseFormat,
      // omit (let the API default) rather than serialize NaN → null on bad input
      temperature: Number.isFinite(temperature) ? temperature : undefined,
    })
  }
  return body
}

/** Resolve the current status of a generation based on its metadata and result fields */
export function generationStatus(generation: Generation): GenerationStatus {
  const metadata = generation.metadata ?? {}
  const status = typeof metadata.generationStatus === 'string' ? metadata.generationStatus : ''
  if (status === 'pending' || status === 'running' || status === 'failed' || status === 'succeeded') return status
  return generation.result ? 'succeeded' : 'pending'
}

/** Resolve and return the first user-safe error message from generation metadata or null if none exist */
export function generationError(generation: Generation): string | null {
  const metadata = generation.metadata ?? {}
  if (typeof metadata.providerError === 'string' && metadata.providerError.trim()) {
    return userSafeGenerationMessage(metadata.providerError)
  }
  if (typeof metadata.storageError === 'string' && metadata.storageError.trim()) {
    return metadata.storageError
  }
  return null
}

function generationClientRequestId(generation: Generation): string | null {
  const metadata = generation.metadata ?? {}
  return typeof metadata.clientRequestId === 'string' && metadata.clientRequestId.trim()
    ? metadata.clientRequestId
    : null
}

function generationBatchSlotKey(generation: Generation): string | null {
  const metadata = generation.metadata ?? {}
  const batchId = typeof metadata.batchId === 'string' && metadata.batchId.trim() ? metadata.batchId : null
  return batchId && typeof metadata.outputIndex === 'number'
    ? `${batchId}:${metadata.outputIndex}`
    : null
}

/** Resolve a unique merge key from a generation using batch slot or client request ID */
export function generationMergeKey(generation: Generation): string | null {
  return generationBatchSlotKey(generation) ?? generationClientRequestId(generation)
}

/** Merge a new generation into the current list by replacing or prepending it based on matching keys */
export function mergeLiveGeneration(current: Generation[], generation: Generation): Generation[] {
  const mergeKey = generationMergeKey(generation)
  const existingIndex = current.findIndex((item) => (
    item.id === generation.id
    || (mergeKey && generationMergeKey(item) === mergeKey)
  ))
  if (existingIndex === -1) return [generation, ...current]

  const next = [...current]
  next[existingIndex] = generation
  return next
}

// Overlay in-flight `live` generations on the loader's rows: each live row leads
// (prefer the matching loader row by merge key / id so it carries the freshest
// server state), then the remaining loader rows that no live row already
// represents — deduped by BOTH id and merge key so a server row and its
// optimistic twin never both appear. Returns `loader` unchanged when nothing is
// live. Drives the canvas, library, and polling off one list.
/** Merge two Generation arrays prioritizing live entries and matching by merge keys or IDs */
export function mergeLoaderAndLive(loader: Generation[], live: Generation[]): Generation[] {
  if (live.length === 0) return loader
  const leading = live.map((generation) => {
    const mergeKey = generationMergeKey(generation)
    return mergeKey
      ? loader.find((gen) => generationMergeKey(gen) === mergeKey) ?? generation
      : loader.find((gen) => gen.id === generation.id) ?? generation
  })
  const leadingIds = new Set(leading.map((gen) => gen.id))
  const leadingMergeKeys = new Set(leading
    .map((gen) => generationMergeKey(gen))
    .filter((id): id is string => Boolean(id)))
  return [
    ...leading,
    ...loader.filter((gen) => (
      !leadingIds.has(gen.id)
      && !leadingMergeKeys.has(generationMergeKey(gen) ?? '')
    )),
  ]
}

/** Determine if a generation ID indicates a local generation */
export function isLocalGeneration(generation: Generation): boolean {
  return generation.id.startsWith('local-')
}

function generationOutputIndex(generation: Generation): number {
  const value = generation.metadata?.outputIndex
  return typeof value === 'number' ? value : 0
}

// The most-recent run: all generations sharing the leading item's clientRequestId
// (a multi-image batch), ordered by output slot. Falls back to the single leading
// item when no request id is present. Drives the result canvas.
/** Resolve and return the latest batch of generations grouped and sorted by client request ID and output index */
export function latestBatchOf(generations: Generation[]): Generation[] {
  const first = generations[0]
  if (!first) return []
  const key = generationClientRequestId(first)
  const batch = key
    ? generations.filter((generation) => generationClientRequestId(generation) === key)
    : [first]
  return [...batch].sort((a, b) => generationOutputIndex(a) - generationOutputIndex(b))
}

/** Resolve a user-safe generation message by filtering sensitive or error-related content */
export function userSafeGenerationMessage(message?: string): string {
  if (!message) return 'Generation failed'
  if (/Tangle API key is invalid or expired/i.test(message)) return message
  if (/(api[_ -]?key|secret|token|credential|env|configured|configuration)/i.test(message)) {
    return 'Generation failed'
  }
  return message
}

/** Generate content optimistically based on input parameters and optional model and output details */
export function optimisticGeneration({
  type,
  prompt,
  model,
  clientRequestId,
  outputIndex,
  outputCount,
}: {
  type: GenerationType
  prompt: string
  model?: string
  clientRequestId: string
  outputIndex?: number
  outputCount?: number
}, aspectRatio?: number): Generation {
  const batchId = outputIndex == null ? undefined : clientRequestId
  const aspectRatioMetadata = Number.isFinite(aspectRatio) && (aspectRatio ?? 0) > 0
    ? { aspectRatio }
    : {}
  return {
    id: outputIndex == null ? `local-${clientRequestId}` : `local-${clientRequestId}-${outputIndex}`,
    type,
    prompt,
    result: null,
    model: model ?? null,
    cost: null,
    createdAt: new Date(),
    metadata: {
      generationStatus: 'pending',
      provider: type,
      clientRequestId,
      batchId,
      outputIndex,
      outputCount,
      ...aspectRatioMetadata,
    },
  }
}

/** Mark a generation as failed with updated status and error information */
export function failedOptimisticGeneration(generation: Generation): Generation {
  return {
    ...generation,
    metadata: {
      ...(generation.metadata ?? {}),
      generationStatus: 'failed',
      providerError: 'Generation failed',
    },
  }
}

/** Normalize a value to a finite integer within the allowed image count range */
export function normalizeImageCount(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return MIN_IMAGE_COUNT
  return Math.min(Math.max(Math.trunc(numeric), MIN_IMAGE_COUNT), MAX_IMAGE_COUNT)
}

/** Resolve a generation's batch identity, preferring the server batch id. */
export function generationBatchKey(generation: Generation): string {
  const metadata = generation.metadata ?? {}
  if (typeof metadata.batchId === 'string' && metadata.batchId.trim()) return metadata.batchId
  if (typeof metadata.clientRequestId === 'string' && metadata.clientRequestId.trim()) return metadata.clientRequestId
  return generation.id
}

/** Resolve the stored media asset id, when present. */
export function generationAssetId(generation: Generation): string | null {
  const value = generation.metadata?.assetId
  return typeof value === 'string' && value.trim() ? value : null
}

/** Select and order all outputs belonging to a generation batch. */
export function generationsInBatch(generations: readonly Generation[], batchKey: string): Generation[] {
  return generations
    .map((generation, inputIndex) => ({ generation, inputIndex }))
    .filter(({ generation }) => generationBatchKey(generation) === batchKey)
    .sort((left, right) => {
      const leftIndex = left.generation.metadata?.outputIndex
      const rightIndex = right.generation.metadata?.outputIndex
      const leftOrder = typeof leftIndex === 'number' && Number.isFinite(leftIndex) ? leftIndex : Infinity
      const rightOrder = typeof rightIndex === 'number' && Number.isFinite(rightIndex) ? rightIndex : Infinity
      return leftOrder - rightOrder || left.inputIndex - right.inputIndex
    })
    .map(({ generation }) => generation)
}

function ratioFromDimensions(value: string, separator: 'size' | 'aspect'): number | undefined {
  const match = separator === 'size'
    ? /^(\d+)[x×](\d+)$/.exec(value)
    : /^(\d+):(\d+)$/.exec(value)
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  return width > 0 && height > 0 ? width / height : undefined
}

function roundedRatio(value: number): number {
  return +value.toFixed(4)
}

/** Resolve the best available aspect ratio for a generation row. */
export function generationAspectRatio(generation: Generation): number {
  const metadata = generation.metadata ?? {}
  if (typeof metadata.aspectRatio === 'number'
    && Number.isFinite(metadata.aspectRatio)
    && metadata.aspectRatio > 0) {
    return roundedRatio(metadata.aspectRatio)
  }
  if (typeof metadata.size === 'string') {
    const ratio = ratioFromDimensions(metadata.size, 'size')
    if (ratio !== undefined) return roundedRatio(ratio)
  }
  if (typeof metadata.aspectRatio === 'string') {
    const ratio = ratioFromDimensions(metadata.aspectRatio, 'aspect')
    if (ratio !== undefined) return roundedRatio(ratio)
  }
  if (generation.type === 'video') return roundedRatio(16 / 9)
  if (generation.type === 'speech' || generation.type === 'audio') return 3.2
  return 1
}

/** Resolve a requested lane's aspect ratio from its selected options. */
export function aspectRatioFromOptions(
  type: GenerationType,
  options: { size?: string; aspectRatio?: string },
): number | undefined {
  if (type === 'speech') return 3.2
  const ratio = type === 'image'
    ? options.size ? ratioFromDimensions(options.size, 'size') : undefined
    : type === 'video'
      ? options.aspectRatio ? ratioFromDimensions(options.aspectRatio, 'aspect') : undefined
      : undefined
  return ratio === undefined ? undefined : roundedRatio(ratio)
}

/** Choose the default vault folder shared by a homogeneous media selection. */
export function defaultVaultPathFor(generations: readonly Generation[]): string {
  const types = new Set(generations.map((generation) => generation.type))
  if (types.size !== 1) return 'generated/media'
  const [type] = types
  return type !== undefined && isGenerationType(type) ? outputPathFor(type) : 'generated/media'
}

/** Normalize a user-entered relative vault folder or reject an unsafe path. */
export function normalizeVaultPath(input: string): string | null {
  const path = input.trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/')
  if (!path) return null
  const segments = path.split('/')
  return segments.some((segment) => segment === '.' || segment === '..' || segment.includes('\\'))
    ? null
    : path
}

/** Append a page while preserving the first row seen for each id. */
export function mergeGenerationPages(prev: readonly Generation[], next: readonly Generation[]): Generation[] {
  const seen = new Set(prev.map((generation) => generation.id))
  const merged = [...prev]
  for (const generation of next) {
    if (seen.has(generation.id)) continue
    seen.add(generation.id)
    merged.push(generation)
  }
  return merged
}

/** Resolve only the human-readable media specification fields a row carries. */
export function generationSpecSegments(generation: Generation): string[] {
  const metadata = generation.metadata ?? {}
  const segments: string[] = []
  if (typeof metadata.size === 'string') segments.push(metadata.size.replace(/x/g, '×'))
  if (typeof metadata.resolution === 'string') segments.push(metadata.resolution)
  if (typeof metadata.aspectRatio === 'string' && /^(\d+):(\d+)$/.test(metadata.aspectRatio)) {
    segments.push(metadata.aspectRatio)
  }
  if (typeof metadata.duration === 'string') {
    segments.push(metadata.duration)
  } else if (typeof metadata.durationSeconds === 'number' && Number.isFinite(metadata.durationSeconds)) {
    const seconds = Math.max(0, Math.floor(metadata.durationSeconds))
    segments.push(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`)
  }
  if (typeof metadata.voice === 'string') segments.push(metadata.voice)
  return segments
}
