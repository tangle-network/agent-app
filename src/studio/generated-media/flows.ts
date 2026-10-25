/**
 * The provider-side steps of a direct media generation, over a product's
 * generated-media store and its bound Router client: ingesting a provider
 * result into the workspace, settling a video or avatar job, persisting
 * provider images, speech and transcripts, and advancing a running job when
 * it is polled. The product keeps its routes, rows, billing, costs and
 * approvals; each step returns the stored-metadata fields it produced so the
 * product writes them through `generationMetadata`.
 */
import { requiredText, type GenerateInputs } from '../../media/generate-request'
import {
  browserUsableSourceUrl,
  metadataResultUrl,
  normalizeProviderJobStatus,
  providerImageBytes,
  type GenerationMetadataFields,
} from '../../media/generation-record'
import type { RouterMediaSource } from '../../media/router-client'
import { fetchBoundedAudio, type RouterAvatarRequest, type RouterTranscriptionRequest } from '../../media/router-generation'
import type { SpeechInput } from '../../media/speech-script'
import { ToolInputError } from '../../tools/errors'
import { withTimeout } from '../../web/timeout'
import type { GenerationStatus } from '../generation'
import { extensionForGeneratedMimeType } from './output'
import type { GeneratedMediaStore, PersistedGeneratedMedia } from './store'

/** How long ingesting a provider result into the workspace may take. */
export const GENERATED_MEDIA_INGEST_TIMEOUT_MS = 30_000
/** How long a pending generation may wait for a provider job id before polling fails it. */
export const STALE_PENDING_GENERATION_MS = 5 * 60 * 1000

const AVATAR_TIMEOUT_MS = 30_000
const SPEECH_TIMEOUT_MS = 45_000
const TRANSCRIPTION_TIMEOUT_MS = 45_000
const TRANSCRIPTION_AUDIO_TIMEOUT_MS = 15_000

/** The generation types whose provider returns a job that may finish later. */
export type ProviderJobMediaType = 'video' | 'avatar'

/** A video or avatar provider's submit response. */
export interface ProviderMediaJobResponse {
  job_id?: string
  id?: string
  status?: string
  video_url?: string
  url?: string
  polling_url?: string
}

/** A provider result ingested into the workspace, or the reason it was not. */
export interface GeneratedMediaIngestion {
  media: PersistedGeneratedMedia | null
  storageStatus: 'saved' | 'failed'
  storageError?: string
}

/** The stored-metadata fields that describe one persisted media file. */
export type PersistedMediaFields = Pick<
  GenerationMetadataFields,
  'assetId' | 'assetVersionId' | 'vaultPath' | 'savedToVaultAt' | 'r2Key' | 'mimeType' | 'sizeBytes'
>

/** A persisted provider image: its workspace file, or the provider URL kept as the result. */
export type PersistedProviderImage = { url: string } & Partial<Omit<PersistedGeneratedMedia, 'url'>>

/** The settled state of a video or avatar job and the metadata fields it adds to the row. */
export interface SettledProviderJob {
  /** The browser-usable result: the ingested file, else a public provider URL, else null while the job runs. */
  result: string | null
  media: PersistedGeneratedMedia | null
  fields: Pick<
    GenerationMetadataFields,
    | 'status' | 'provider' | 'providerJobId' | 'providerStatus' | 'resultUrl' | 'providerResultUrl'
    | 'pollingUrl' | 'storageStatus' | 'storageError'
  > & PersistedMediaFields
}

/** The generation row fields a provider-job poll reads. */
export interface PolledGenerationRow {
  workspaceId: string
  prompt: string
  model: string | null
  result: string | null
  createdAt: Date
  metadata: unknown
}

/** What a poll decided for a generation row; the product writes the row. */
export type ProviderJobRefresh =
  /** Nothing to write: the row is settled, not a provider job, or unchanged since the last poll. */
  | { kind: 'unchanged' }
  /** A pending row never received a provider job id before the deadline; `metadata` fails it. */
  | { kind: 'stale'; metadata: Record<string, unknown> }
  /** The provider job moved; write `result` and `metadata`. */
  | { kind: 'update'; status: GenerationStatus; resultUrl?: string; result: string | null; metadata: Record<string, unknown> }
  /** The poll itself failed; `metadata` records the error so the next poll retries. */
  | { kind: 'poll-failed'; metadata: Record<string, unknown> }

export interface GeneratedMediaFlowsConfig<Context> {
  store: Pick<
    GeneratedMediaStore<Context>,
    'persistGeneratedMediaAsset' | 'persistGeneratedMediaFromUrl' | 'cleanupGeneratedMediaAsset' | 'writeGeneratedTranscriptVaultFile'
  >
  /** The bound Router media client's source resolution and job poll. */
  router: {
    resolveRouterMediaSource(value: string, apiKey?: string): RouterMediaSource
    routerMediaStatus(id: string, signal?: AbortSignal, apiKey?: string): Promise<Record<string, unknown>>
  }
  /** The bound Router generation calls. */
  generation: {
    generateAvatarViaRouter(body: RouterAvatarRequest, signal: AbortSignal | undefined, apiKey: string): Promise<Record<string, unknown>>
    transcribeViaRouter(request: RouterTranscriptionRequest): Promise<{ text?: string }>
  }
  /**
   * Products with an explicit save-to-Vault step record `savedToVaultAt: null`
   * on media they store, so the library can tell stored media from saved media.
   */
  recordVaultSave?: boolean
  /** The provider error stored on a row; defaults to the message, capped at 500 characters. */
  sanitizeProviderError?: (message: string) => string
}

interface MediaActor<Context> {
  context: Context
  workspaceId: string
  userId: string
  prompt: string
  model: string
  outputPath: string | null
  /** Rechecks the caller's live authorization before persistence. */
  recheck?: () => Promise<void>
}

/** Bind the provider-side generation steps to a product's store and Router client. */
export function createGeneratedMediaFlows<Context>(config: GeneratedMediaFlowsConfig<Context>) {
  return {
    mediaFields: (media: Parameters<typeof mediaFields>[1]) => mediaFields(config, media),
    ingestFromUrl: (input: Parameters<typeof ingestFromUrl<Context>>[1]) => ingestFromUrl(config, input),
    settleProviderJob: (
      response: ProviderMediaJobResponse,
      providerJobId: string | null,
      input: Parameters<typeof settleProviderJob<Context>>[3],
    ) => settleProviderJob(config, response, providerJobId, input),
    generateAvatar: (input: Parameters<typeof generateAvatar<Context>>[1]) => generateAvatar(config, input),
    generateSpeech: (input: Parameters<typeof generateSpeech<Context>>[1]) => generateSpeech(config, input),
    transcribe: (input: Parameters<typeof transcribe<Context>>[1]) => transcribe(config, input),
    persistProviderImage: (input: Parameters<typeof persistProviderImage<Context>>[1]) => persistProviderImage(config, input),
    cleanupPersistedImages: (context: Context, images: readonly PersistedProviderImage[]) => cleanupPersistedImages(config, context, images),
    refreshProviderJob: (row: PolledGenerationRow, input: Parameters<typeof refreshProviderJob<Context>>[2]) => refreshProviderJob(config, row, input),
  }
}

function defaultSanitize(message: string): string {
  return message.slice(0, 500)
}

/** The stored-metadata fields of one persisted media file. */
function mediaFields<Context>(config: GeneratedMediaFlowsConfig<Context>, media: Omit<PersistedGeneratedMedia, 'url'> | Partial<Omit<PersistedGeneratedMedia, 'url'>> | null): PersistedMediaFields {
  return {
    assetId: media?.assetId,
    assetVersionId: media?.assetVersionId,
    vaultPath: media?.vaultPath,
    ...(config.recordVaultSave && media?.assetVersionId ? { savedToVaultAt: null } : {}),
    r2Key: media?.r2Key,
    mimeType: media?.mimeType,
    sizeBytes: media?.sizeBytes,
  }
}

/**
 * Ingest a provider result URL into the workspace. A storage failure is
 * reported rather than thrown, so the provider's work is not discarded; an
 * authorization or tool-input failure still throws.
 */
async function ingestFromUrl<Context>(config: GeneratedMediaFlowsConfig<Context>, input: {
  context: Context
  workspaceId: string
  userId: string
  generationType: ProviderJobMediaType
  prompt: string
  model: string | null
  outputPath: string | null | undefined
  sourceUrl: string
  sourceAuthorization?: string
  metadata: Record<string, unknown>
  recheck?: () => Promise<void>
}): Promise<GeneratedMediaIngestion> {
  try {
    const media = await withTimeout(
      (signal) => config.store.persistGeneratedMediaFromUrl({ ...input, signal }),
      GENERATED_MEDIA_INGEST_TIMEOUT_MS,
      `Generated ${input.generationType} ingestion timed out after ${GENERATED_MEDIA_INGEST_TIMEOUT_MS / 1000}s`,
    )
    return { media, storageStatus: 'saved' }
  } catch (err) {
    if (err instanceof ToolInputError) throw err
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Generated ${input.generationType} storage failed:`, message)
    return {
      media: null,
      storageStatus: 'failed',
      storageError: `Generated ${input.generationType} was created, but could not be saved to Vault.`,
    }
  }
}

/**
 * Settle a video or avatar provider response: ingest the video when the
 * provider already returned it, else leave the job running. Router-proxied
 * URLs need the Bearer key, so only the ingested file or a public provider
 * URL becomes the result; a null result keeps the row running so a poll
 * retries ingestion.
 */
async function settleProviderJob<Context>(
  config: GeneratedMediaFlowsConfig<Context>,
  response: ProviderMediaJobResponse,
  providerJobId: string | null,
  input: MediaActor<Context> & {
    generationType: ProviderJobMediaType
    apiKey: string
    /** Request fields recorded on the ingested asset. */
    sourceMetadata: Record<string, unknown>
  },
): Promise<SettledProviderJob> {
  const providerStatus = requiredText(response.status) ?? (providerJobId ? 'pending' : 'submitted')
  const providerResultUrl = requiredText(response.video_url) ?? requiredText(response.url)
  if (!providerResultUrl && !providerJobId) {
    throw new Error(`${input.generationType === 'video' ? 'Video' : 'Avatar'} provider returned neither a video URL nor a job id`)
  }
  await input.recheck?.()
  const source = providerResultUrl ? config.router.resolveRouterMediaSource(providerResultUrl, input.apiKey) : null
  const ingestion = source
    ? await ingestFromUrl(config, {
        context: input.context,
        workspaceId: input.workspaceId,
        userId: input.userId,
        generationType: input.generationType,
        prompt: input.prompt,
        model: input.model,
        outputPath: input.outputPath,
        sourceUrl: source.url,
        sourceAuthorization: source.authorization,
        metadata: { providerJobId: providerJobId ?? undefined, providerStatus, ...input.sourceMetadata },
        recheck: input.recheck,
      })
    : null
  const media = ingestion?.media ?? null
  const result = media?.url ?? browserUsableSourceUrl(source)
  return {
    result,
    media,
    fields: {
      status: result ? 'succeeded' : 'running',
      provider: input.generationType,
      providerJobId: providerJobId ?? undefined,
      providerStatus,
      resultUrl: result ?? undefined,
      providerResultUrl: source?.url,
      pollingUrl: response.polling_url,
      storageStatus: ingestion?.storageStatus,
      storageError: ingestion?.storageError,
      ...mediaFields(config, media),
    },
  }
}

/** Submit an avatar job through the Router and settle its response. */
async function generateAvatar<Context>(config: GeneratedMediaFlowsConfig<Context>, input: MediaActor<Context> & {
  effectivePrompt: string
  inputs: GenerateInputs
  apiKey: string
  callbackUrl?: string
}): Promise<SettledProviderJob> {
  const audioUrl = requiredText(input.inputs.audioUrl)
  if (!audioUrl) throw new Error('audioUrl is required')
  const response = await withTimeout(
    (signal) => config.generation.generateAvatarViaRouter(
      {
        model: input.model,
        prompt: input.effectivePrompt,
        audio_url: audioUrl,
        image_url: input.inputs.imageUrl,
        avatar_id: input.inputs.avatarId,
        callback_url: input.callbackUrl,
      },
      signal,
      input.apiKey,
    ),
    AVATAR_TIMEOUT_MS,
    `Avatar generation did not return a provider job within ${AVATAR_TIMEOUT_MS / 1000}s`,
  ) as ProviderMediaJobResponse
  return settleProviderJob(config, response, requiredText(response.job_id) ?? requiredText(response.id), {
    ...input,
    generationType: 'avatar',
    sourceMetadata: { audioUrl, imageUrl: input.inputs.imageUrl, avatarId: input.inputs.avatarId },
  })
}

/**
 * Speak a prompt and store the audio. `resolveSpeechInput` decides whether the
 * prompt is read literally or scripted first; `speak` is the product's
 * text-to-speech call, bounded but not cancelled by the timeout.
 */
async function generateSpeech<Context>(config: GeneratedMediaFlowsConfig<Context>, input: MediaActor<Context> & {
  voice: string
  apiKey: string
  /** The request's checked inputs; the stored record adds how the spoken text was produced. */
  inputs: GenerateInputs
  resolveSpeechInput(prompt: string, apiKey: string): Promise<SpeechInput>
  speak(request: { input: string; model: string; voice: string }): Promise<unknown>
}): Promise<{ media: PersistedGeneratedMedia; speechInput: SpeechInput; fields: GenerationMetadataFields }> {
  const speechInput = await input.resolveSpeechInput(input.prompt, input.apiKey)
  const audio = await withTimeout(
    () => input.speak({ input: speechInput.input, model: input.model, voice: input.voice }),
    SPEECH_TIMEOUT_MS,
    `Speech generation timed out after ${SPEECH_TIMEOUT_MS / 1000}s for model ${input.model}`,
  )
  const bytes = new Uint8Array(audio as ArrayBuffer)
  if (bytes.length === 0) throw new Error(`Speech provider returned empty audio for model ${input.model}`)
  const media = await config.store.persistGeneratedMediaAsset({
    context: input.context,
    workspaceId: input.workspaceId,
    userId: input.userId,
    generationType: 'speech',
    prompt: input.prompt,
    model: input.model,
    outputPath: input.outputPath,
    bytes,
    mimeType: 'audio/mpeg',
    metadata: { voice: input.voice },
    recheck: input.recheck,
  })
  return {
    media,
    speechInput,
    fields: {
      status: 'succeeded',
      provider: 'speech',
      inputs: {
        ...input.inputs,
        speechInputMode: speechInput.mode,
        speechInput: speechInput.input,
        scriptCostUsd: speechInput.scriptCostUsd,
      },
      resultUrl: metadataResultUrl(media.url),
      ...mediaFields(config, media),
    },
  }
}

/** Transcribe the request's audio URL and write the transcript into the Vault. */
async function transcribe<Context>(config: GeneratedMediaFlowsConfig<Context>, input: {
  workspaceId: string
  generationId: string
  prompt: string
  model: string
  outputPath: string | null
  inputs: GenerateInputs
  apiKey: string
  createdAt: Date
}): Promise<{ text: string; fields: GenerationMetadataFields }> {
  const { inputs, model } = input
  const audioUrl = requiredText(inputs.audioUrl)
  if (!audioUrl) throw new Error('audioUrl is required')
  // No redirects, audio content only, size-capped, public host re-checked.
  const audioBlob = await withTimeout(
    (signal) => fetchBoundedAudio(audioUrl, { signal }),
    TRANSCRIPTION_AUDIO_TIMEOUT_MS,
    `Timed out fetching transcription audio from ${audioUrl}`,
  )
  const response = await withTimeout(
    (signal) => config.generation.transcribeViaRouter({
      audioBlob,
      audioUrl,
      model,
      language: inputs.language,
      prompt: input.prompt || undefined,
      responseFormat: inputs.responseFormat,
      temperature: inputs.temperature,
      signal,
      apiKey: input.apiKey,
    }),
    TRANSCRIPTION_TIMEOUT_MS,
    `Transcription timed out after ${TRANSCRIPTION_TIMEOUT_MS / 1000}s for model ${model}`,
  )
  const text = response.text ?? null
  if (!text) throw new Error(`Transcription provider returned no text for model ${model}`)
  const file = await config.store.writeGeneratedTranscriptVaultFile({
    workspaceId: input.workspaceId,
    generationId: input.generationId,
    prompt: input.prompt || audioUrl,
    model,
    outputPath: input.outputPath,
    transcript: text,
    sourceAudioUrl: audioUrl,
    language: typeof inputs.language === 'string' ? inputs.language : undefined,
    responseFormat: typeof inputs.responseFormat === 'string' ? inputs.responseFormat : undefined,
    createdAt: input.createdAt,
    status: 'succeeded',
  })
  return { text, fields: { status: 'succeeded', provider: 'transcription', vaultPath: file.vaultPath } }
}

/**
 * Persist one provider image. Inline bytes and data URIs are stored in the
 * workspace; a remote URL is ingested when `remoteUrl` is `'ingest'`, or kept
 * as the result when it is `'link'`.
 */
async function persistProviderImage<Context>(config: GeneratedMediaFlowsConfig<Context>, input: Omit<MediaActor<Context>, 'recheck'> & {
  size: string
  quality: string
  url?: string
  b64Json?: string
  remoteUrl: 'ingest' | 'link'
  recheck?: () => Promise<void>
}): Promise<PersistedProviderImage> {
  const base = {
    context: input.context,
    workspaceId: input.workspaceId,
    userId: input.userId,
    generationType: 'image' as const,
    prompt: input.prompt,
    model: input.model,
    outputPath: input.outputPath,
    metadata: { size: input.size, quality: input.quality },
    recheck: input.recheck,
  }
  const url = requiredText(input.url)
  if (url && !url.startsWith('data:')) {
    if (input.remoteUrl === 'link') return { url }
    return config.store.persistGeneratedMediaFromUrl({ ...base, sourceUrl: url })
  }
  const image = providerImageBytes(url, input.b64Json)
  if (!image) throw new Error(`Image provider returned no image for model ${input.model}`)
  return config.store.persistGeneratedMediaAsset({
    ...base,
    bytes: image.bytes,
    mimeType: image.mimeType,
    extension: extensionForGeneratedMimeType('image', image.mimeType),
  })
}

/** Remove the workspace files of images persisted before a batch failed. */
async function cleanupPersistedImages<Context>(config: GeneratedMediaFlowsConfig<Context>, context: Context, images: readonly PersistedProviderImage[]): Promise<void> {
  await Promise.all(images.map(async (image) => {
    if (!image.assetId || !image.assetVersionId || !image.r2Key) return
    await config.store.cleanupGeneratedMediaAsset(context, {
      assetId: image.assetId,
      assetVersionId: image.assetVersionId,
      r2Key: image.r2Key,
    })
  }))
}

/**
 * Advance a running video or avatar generation from its provider job: a
 * succeeded job's video is ingested once, a no-op poll writes nothing, and a
 * pending row that never received a job id fails after the deadline.
 */
async function refreshProviderJob<Context>(config: GeneratedMediaFlowsConfig<Context>, row: PolledGenerationRow, input: {
  context: Context
  userId: string
  apiKey: string
}): Promise<ProviderJobRefresh> {
  const metadata = metadataRecord(row.metadata)
  const status = stringValue(metadata.generationStatus)
  if (status !== 'running' && status !== 'pending') return { kind: 'unchanged' }

  const providerJobId = stringValue(metadata.providerJobId)
  const provider = stringValue(metadata.provider)
  if (!providerJobId) {
    if (status === 'pending' && Date.now() - row.createdAt.getTime() > STALE_PENDING_GENERATION_MS) {
      return {
        kind: 'stale',
        metadata: {
          ...metadata,
          generationStatus: 'failed',
          providerError: 'Generation did not receive a provider job id before the polling deadline.',
        },
      }
    }
    return { kind: 'unchanged' }
  }
  if (provider !== 'video' && provider !== 'avatar') return { kind: 'unchanged' }

  try {
    const normalized = normalizeProviderJobStatus(await config.router.routerMediaStatus(providerJobId, undefined, input.apiKey))
    const existingAssetVersionId = stringValue(metadata.assetVersionId)
    const source = normalized.resultUrl ? config.router.resolveRouterMediaSource(normalized.resultUrl, input.apiKey) : null
    const providerResultUrl = source?.url
    // Router-proxied URLs need the Bearer key, so the browser cannot load them;
    // only the ingested asset URL (or a public provider URL) may be stored.
    let resultUrl = source && !source.authorization ? source.url : undefined
    let mediaMetadata: Record<string, unknown> = {}
    if (normalized.status === 'succeeded' && source && existingAssetVersionId) {
      resultUrl = stringValue(metadata.resultUrl) ?? row.result ?? resultUrl
    }
    if (normalized.status === 'succeeded' && source && !existingAssetVersionId) {
      try {
        const media = await withTimeout(
          (signal) => config.store.persistGeneratedMediaFromUrl({
            context: input.context,
            workspaceId: row.workspaceId,
            userId: input.userId,
            generationType: provider,
            prompt: row.prompt,
            model: row.model,
            outputPath: stringValue(metadata.outputPath),
            sourceUrl: source.url,
            sourceAuthorization: source.authorization,
            signal,
            metadata: { providerJobId, providerStatus: normalized.providerStatus },
          }),
          GENERATED_MEDIA_INGEST_TIMEOUT_MS,
          `Generated ${provider} ingestion timed out after ${GENERATED_MEDIA_INGEST_TIMEOUT_MS / 1000}s`,
        )
        resultUrl = media.url
        mediaMetadata = { providerResultUrl, ...mediaFields(config, media), storageStatus: 'saved' }
      } catch (err) {
        // Router-proxied sources have no public fallback URL to show: surface
        // the failure as a poll error so the row stays running and the next
        // poll retries ingestion.
        if (source.authorization) throw err
        const message = err instanceof Error ? err.message : String(err)
        console.error(`Generated ${provider} storage failed during polling:`, message)
        mediaMetadata = {
          providerResultUrl,
          storageStatus: 'failed',
          storageError: `Generated ${provider} was created, but could not be saved to Vault.`,
        }
      }
    }

    // Skip the write when nothing material changed since the last poll: a
    // studio polls every running id every few seconds across tabs, so a no-op
    // write is a storm, and a GET loader should not churn the row.
    const unchanged = normalized.status === status
      && (!resultUrl || resultUrl === stringValue(metadata.resultUrl))
      && !normalized.error
    if (unchanged) return { kind: 'unchanged' }

    return {
      kind: 'update',
      status: normalized.status,
      resultUrl,
      result: resultUrl ?? row.result,
      metadata: {
        ...metadata,
        generationStatus: normalized.status,
        providerStatus: normalized.providerStatus,
        providerError: normalized.error ? (config.sanitizeProviderError ?? defaultSanitize)(normalized.error) : undefined,
        lastPollError: undefined,
        lastPollErrorAt: undefined,
        resultUrl: resultUrl ?? metadata.resultUrl,
        ...mediaMetadata,
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to refresh provider job'
    return {
      kind: 'poll-failed',
      metadata: { ...metadata, lastPollError: (config.sanitizeProviderError ?? defaultSanitize)(message), lastPollErrorAt: new Date().toISOString() },
    }
  }
}

export type GeneratedMediaFlows<Context> = ReturnType<typeof createGeneratedMediaFlows<Context>>

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
