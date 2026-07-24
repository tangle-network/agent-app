// Minimal structural view of a connected integration — `isDestinationConnected`
// only reads the connection status and the provider/connector identifiers, so
// the logic layer declares its own shape instead of depending on the
// design-system package. A sandbox-ui `IntegrationConnection` is assignable to
// this; `connectorId` is optional because the engine type leaves it undefined
// for connections established without a named connector.
/** Define the structure for a studio integration connection with status and provider identifiers */
export interface StudioIntegrationConnection {
  status: string
  providerId: string
  connectorId?: string
}

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

/** Describe media model option properties including id, name, type, status, and optional provider and reason */
export interface MediaModelOption {
  id: string
  name: string
  provider?: string
  type: GenerationType
  status: MediaModelStatus
  reason?: string
}

/** Represent media model catalog with default values, model options, and optional error message */
export interface MediaModelCatalogResponse {
  defaults: Record<GenerationType, string>
  models: Record<GenerationType, MediaModelOption[]>
  error?: string
}

/** Define the structure for configuring package publishing details and evaluation criteria */
export interface PublishPackage {
  caption: string
  description: string
  mentions: string[]
  destinations: string[]
  cadence: string
  workflowDraft: boolean
  evalContract: {
    artifactType: string
    deterministicChecks: string[]
  }
}

/** Define a destination for publishing content with identifiers, label, provider IDs, and fields */
export interface PublishDestination {
  id: string
  label: string
  providerIds: string[]
  fields: string
}

// Order drives the type filter tabs and the composer segmented control
/** Provide an array of supported generation types for media and content processing */
export const GENERATION_TYPES: readonly GenerationType[] = ['image', 'video', 'avatar', 'speech', 'transcription']

/** Resolve whether a string value matches a valid GenerationType */
export function isGenerationType(value: string): value is GenerationType {
  return (GENERATION_TYPES as readonly string[]).includes(value)
}

/** List available social media platforms with their publishing fields and provider identifiers */
export const DESTINATIONS: PublishDestination[] = [
  { id: 'instagram', label: 'Instagram', providerIds: ['instagram'], fields: 'Caption, hashtags, crop' },
  { id: 'tiktok', label: 'TikTok', providerIds: ['tiktok'], fields: 'Caption, audio note, vertical video' },
  { id: 'youtube-shorts', label: 'YouTube Shorts', providerIds: ['youtube'], fields: 'Title, description, vertical video' },
  { id: 'linkedin', label: 'LinkedIn', providerIds: ['linkedin'], fields: 'Caption, link, creator/company page' },
  { id: 'x', label: 'X', providerIds: ['twitter'], fields: 'Short copy, mentions, thread option' },
]

/** Provide an array of predefined cadence options for scheduling or approval processes */
export const CADENCES = ['Manual approval', 'Publish now', 'Daily creative drop', 'Weekly series']

/** Define the minimum number of images required for processing or validation */
export const MIN_IMAGE_COUNT = 1
/** Define the maximum number of images allowed for upload or display */
export const MAX_IMAGE_COUNT = 4

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

/** Build a PublishPackage object from caption, description, mentions, cadence, and destinations inputs */
export function buildPublishPackage({
  caption,
  postDescription,
  mentions,
  cadence,
  destinations,
}: {
  caption: string
  postDescription: string
  mentions: string
  cadence: string
  destinations: string[]
}): PublishPackage | null {
  const trimmedCaption = caption.trim()
  const trimmedDescription = postDescription.trim()
  const parsedMentions = mentions.split(',').map((item) => item.trim()).filter(Boolean)
  const selectedDestinations = destinations.filter(Boolean)
  const trimmedCadence = cadence.trim() || 'Manual approval'
  const hasPublishContent = Boolean(
    trimmedCaption
    || trimmedDescription
    || parsedMentions.length > 0
    || selectedDestinations.length > 0
    || trimmedCadence !== 'Manual approval',
  )
  if (!hasPublishContent) return null

  return {
    caption: trimmedCaption,
    description: trimmedDescription,
    mentions: parsedMentions,
    destinations: selectedDestinations,
    cadence: trimmedCadence,
    workflowDraft: trimmedCadence !== 'Manual approval',
    evalContract: {
      artifactType: 'publish_package',
      deterministicChecks: ['has_asset', 'has_destination', 'has_caption_or_description', 'has_cadence'],
    },
  }
}

/** Determine if a value conforms to the PublishPackage structure with optional metadata fields */
export function isPublishPackage(value: unknown): value is { caption?: string; description?: string; mentions?: string[]; destinations?: string[]; cadence?: string } {
  if (!value || typeof value !== 'object') return false
  const publishPackage = value as {
    caption?: unknown
    description?: unknown
    mentions?: unknown
    destinations?: unknown
    cadence?: unknown
  }
  const destinations = Array.isArray(publishPackage.destinations) ? publishPackage.destinations.filter(Boolean) : []
  const mentions = Array.isArray(publishPackage.mentions) ? publishPackage.mentions.filter(Boolean) : []
  return Boolean(
    destinations.length > 0
    || mentions.length > 0
    || (typeof publishPackage.caption === 'string' && publishPackage.caption.trim())
    || (typeof publishPackage.description === 'string' && publishPackage.description.trim())
    || (typeof publishPackage.cadence === 'string' && publishPackage.cadence.trim() && publishPackage.cadence.trim() !== 'Manual approval'),
  )
}

/** Determine if a destination has any active connections in the given list of studio integration connections */
export function isDestinationConnected(
  destination: PublishDestination,
  connections: StudioIntegrationConnection[],
): boolean {
  return connections.some((connection) => connection.status === 'connected'
    && (destination.providerIds.includes(connection.providerId)
      || (connection.connectorId !== undefined && destination.providerIds.includes(connection.connectorId))))
}

/** Resolve selected models by applying defaults for missing or unavailable entries in the catalog */
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
  return models.find((model) => model.id === preferred)?.id
    ?? models.find((model) => model.status !== 'unavailable')?.id
    ?? models[0]?.id
}

/** Resolve the appropriate status message for a media model based on loading state and availability */
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
  negativePrompt: string
  outputPath: string
  publishPackage: PublishPackage | null
  image: { size: string; quality: string; count: number }
  video: { duration: string; resolution: string; aspectRatio: string; referenceImageUrl: string }
  speech: { voice: string }
  avatar: { audioUrl: string; imageUrl: string; avatarId: string }
  transcription: { audioUrl: string; language: string; responseFormat: string; temperature: string }
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
    negativePrompt: fields.negativePrompt.trim() || undefined,
    outputPath: fields.outputPath.trim() || undefined,
  }
  if (fields.publishPackage) body.publishPackage = fields.publishPackage
  if (fields.type === 'image') Object.assign(body, {
    size: fields.image.size,
    quality: fields.image.quality,
    n: fields.image.count,
  })
  if (fields.type === 'video') {
    const duration = Number(fields.video.duration)
    Object.assign(body, {
      // omit (let the API default) rather than serialize NaN → null on bad input
      duration: Number.isFinite(duration) ? duration : undefined,
      resolution: fields.video.resolution,
      aspectRatio: fields.video.aspectRatio.trim() || undefined,
      referenceImageUrl: fields.video.referenceImageUrl.trim() || undefined,
    })
  }
  if (fields.type === 'speech') Object.assign(body, { voice: fields.speech.voice })
  if (fields.type === 'avatar') Object.assign(body, {
    audioUrl: fields.avatar.audioUrl.trim(),
    imageUrl: fields.avatar.imageUrl.trim() || undefined,
    avatarId: fields.avatar.avatarId.trim() || undefined,
  })
  if (fields.type === 'transcription') {
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
}): Generation {
  const batchId = outputIndex == null ? undefined : clientRequestId
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
