// Minimal structural view of a connected integration — `isDestinationConnected`
// only reads the connection status and the provider/connector identifiers, so
// the logic layer declares its own shape instead of depending on the
// design-system package. A sandbox-ui `IntegrationConnection` is assignable to
// this (it carries all three fields).
export interface StudioIntegrationConnection {
  status: string
  providerId: string
  connectorId: string
}

export type GenerationType = 'image' | 'video' | 'speech' | 'avatar' | 'transcription'

export type GenerationStatus = 'pending' | 'running' | 'succeeded' | 'failed'

export type MediaModelStatus = 'available' | 'limited' | 'unavailable'

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

export interface MediaModelOption {
  id: string
  name: string
  provider?: string
  type: GenerationType
  status: MediaModelStatus
  reason?: string
}

export interface MediaModelCatalogResponse {
  defaults: Record<GenerationType, string>
  models: Record<GenerationType, MediaModelOption[]>
  error?: string
}

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

export interface PublishDestination {
  id: string
  label: string
  providerIds: string[]
  fields: string
}

// Order drives the type filter tabs and the composer segmented control
export const GENERATION_TYPES: readonly GenerationType[] = ['image', 'video', 'avatar', 'speech', 'transcription']

export function isGenerationType(value: string): value is GenerationType {
  return (GENERATION_TYPES as readonly string[]).includes(value)
}

export const DESTINATIONS: PublishDestination[] = [
  { id: 'instagram', label: 'Instagram', providerIds: ['instagram'], fields: 'Caption, hashtags, crop' },
  { id: 'tiktok', label: 'TikTok', providerIds: ['tiktok'], fields: 'Caption, audio note, vertical video' },
  { id: 'youtube-shorts', label: 'YouTube Shorts', providerIds: ['youtube'], fields: 'Title, description, vertical video' },
  { id: 'linkedin', label: 'LinkedIn', providerIds: ['linkedin'], fields: 'Caption, link, creator/company page' },
  { id: 'x', label: 'X', providerIds: ['twitter'], fields: 'Short copy, mentions, thread option' },
]

export const CADENCES = ['Manual approval', 'Publish now', 'Daily creative drop', 'Weekly series']

export const MIN_IMAGE_COUNT = 1
export const MAX_IMAGE_COUNT = 4

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

export function outputPathFor(type: GenerationType): string {
  if (type === 'image') return 'generated/images'
  if (type === 'video') return 'generated/videos'
  if (type === 'avatar') return 'generated/avatars'
  if (type === 'speech') return 'generated/audio'
  return 'generated/transcripts'
}

export function generationVaultPath(generation: Generation): string | null {
  const value = generation.metadata?.vaultPath
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

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

export function isPublishPackage(value: unknown): value is { caption?: string; description?: string; mentions?: string[]; destinations: string[]; cadence?: string } {
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

export function isDestinationConnected(
  destination: PublishDestination,
  connections: StudioIntegrationConnection[],
): boolean {
  return connections.some((connection) => connection.status === 'connected'
    && (destination.providerIds.includes(connection.providerId) || destination.providerIds.includes(connection.connectorId)))
}

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

export function preferredModelId(type: GenerationType, catalog: MediaModelCatalogResponse | null): string | undefined {
  if (!catalog) return undefined
  const models = catalog.models[type] ?? []
  const preferred = catalog.defaults[type]
  return models.find((model) => model.id === preferred)?.id
    ?? models.find((model) => model.status !== 'unavailable')?.id
    ?? models[0]?.id
}

export function modelMessage(model: MediaModelOption | undefined, loading: boolean, count: number): string | null {
  if (loading) return 'Loading media models...'
  if (count === 0) return 'No models are available for this media type.'
  if (!model) return 'Select a model.'
  if (model.status === 'unavailable') return model.reason ?? 'This model is not configured.'
  if (model.status === 'limited') return model.reason ? `Limited: ${model.reason}` : 'Limited availability.'
  return null
}

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
  if (fields.type === 'video') Object.assign(body, {
    duration: Number(fields.video.duration),
    resolution: fields.video.resolution,
    aspectRatio: fields.video.aspectRatio.trim() || undefined,
    referenceImageUrl: fields.video.referenceImageUrl.trim() || undefined,
  })
  if (fields.type === 'speech') Object.assign(body, { voice: fields.speech.voice })
  if (fields.type === 'avatar') Object.assign(body, {
    audioUrl: fields.avatar.audioUrl.trim(),
    imageUrl: fields.avatar.imageUrl.trim() || undefined,
    avatarId: fields.avatar.avatarId.trim() || undefined,
  })
  if (fields.type === 'transcription') Object.assign(body, {
    audioUrl: fields.transcription.audioUrl.trim(),
    language: fields.transcription.language.trim() || undefined,
    responseFormat: fields.transcription.responseFormat,
    temperature: Number(fields.transcription.temperature),
  })
  return body
}

export function generationStatus(generation: Generation): GenerationStatus {
  const metadata = generation.metadata ?? {}
  const status = typeof metadata.generationStatus === 'string' ? metadata.generationStatus : ''
  if (status === 'pending' || status === 'running' || status === 'failed' || status === 'succeeded') return status
  return generation.result ? 'succeeded' : 'pending'
}

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

export function generationMergeKey(generation: Generation): string | null {
  return generationBatchSlotKey(generation) ?? generationClientRequestId(generation)
}

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
export function latestBatchOf(generations: Generation[]): Generation[] {
  const first = generations[0]
  if (!first) return []
  const key = generationClientRequestId(first)
  const batch = key
    ? generations.filter((generation) => generationClientRequestId(generation) === key)
    : [first]
  return [...batch].sort((a, b) => generationOutputIndex(a) - generationOutputIndex(b))
}

export function userSafeGenerationMessage(message?: string): string {
  if (!message) return 'Generation failed'
  if (/Tangle API key is invalid or expired/i.test(message)) return message
  if (/(api[_ -]?key|secret|token|credential|env|configured|configuration)/i.test(message)) {
    return 'Generation failed'
  }
  return message
}

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

export function normalizeImageCount(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return MIN_IMAGE_COUNT
  return Math.min(Math.max(Math.trunc(numeric), MIN_IMAGE_COUNT), MAX_IMAGE_COUNT)
}
