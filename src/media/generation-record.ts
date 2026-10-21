/**
 * The record a media generation leaves behind: the metadata stored on its row,
 * the result URL a browser may be shown, how a provider job's status reads,
 * and the decoding of provider image output. Storage and persistence stay with
 * the product.
 */
import type { GenerationStatus, GenerationType } from '../studio/generation'
import type { RouterMediaSource } from './router-client'
import { requiredText } from './generate-request'

/** Everything a generation's stored metadata can carry. */
export interface GenerationMetadataFields {
  status: GenerationStatus
  provider: GenerationType
  negativePrompt?: string
  outputPath?: string | null
  /** The approved publish package, kept only when the request had one. */
  publishPackage?: Record<string, unknown> | object | null
  inputs?: Record<string, unknown>
  providerJobId?: string
  providerStatus?: string
  providerError?: string
  resultUrl?: string | null
  providerResultUrl?: string | null
  pollingUrl?: string
  storageStatus?: 'saved' | 'failed'
  storageError?: string
  clientRequestId?: string
  batchId?: string
  outputIndex?: number
  outputCount?: number
  assetId?: string
  assetVersionId?: string
  vaultPath?: string
  savedToVaultAt?: string | null
  r2Key?: string
  mimeType?: string
  sizeBytes?: number
  failureCode?: string
  retryable?: boolean
  chatVisibility?: 'hidden'
}

/** A result URL safe to store: data URIs are bytes, never a link. */
export function metadataResultUrl(value: string | null | undefined): string | undefined {
  if (!value || value.startsWith('data:')) return undefined
  return value
}

/** The stored metadata of one generation row, with data URIs kept out of its URLs. */
export function generationMetadata({
  status,
  provider,
  negativePrompt,
  publishPackage,
  resultUrl,
  providerResultUrl,
  ...fields
}: GenerationMetadataFields): Record<string, unknown> {
  return {
    generationStatus: status,
    provider,
    negativePrompt: negativePrompt || undefined,
    ...(publishPackage ? { publishPackage } : {}),
    ...fields,
    resultUrl: metadataResultUrl(resultUrl),
    providerResultUrl: metadataResultUrl(providerResultUrl),
  }
}

/**
 * Router-proxied URLs require the Bearer key, so the browser cannot load them;
 * only public provider URLs are usable as a result before ingestion completes.
 */
export function browserUsableSourceUrl(source: RouterMediaSource | null): string | null {
  if (!source || source.authorization) return null
  return source.url
}

export interface ProviderJobStatus {
  status: 'running' | 'succeeded' | 'failed'
  providerStatus: string
  resultUrl?: string
  error?: string
}

/** Read a provider job's status response or webhook payload (video or avatar) into the three states a generation row has. */
export function normalizeProviderJobStatus(value: unknown): ProviderJobStatus {
  const record = recordValue(value)
  const rawStatus = text(record.status) ?? 'running'
  // A poll response carries the URL at the top level; a webhook payload may nest it under `result` or `output`.
  const resultUrl = [record, recordValue(record.result), recordValue(record.output)]
    .map((source) => text(source.video_url) ?? text(source.url) ?? text(source.result_url) ?? text(source.output_url))
    .find(Boolean)
  const error = text(record.error) ?? text(record.message)
  const lower = rawStatus.toLowerCase()

  if (lower === 'failed' || lower === 'error' || lower === 'cancelled') {
    return { status: 'failed', providerStatus: rawStatus, error: error ?? `Provider job ${rawStatus}` }
  }
  if (lower === 'completed' || lower === 'complete' || lower === 'succeeded' || lower === 'success') {
    if (!resultUrl) {
      return { status: 'failed', providerStatus: rawStatus, error: 'Provider job completed without a result URL' }
    }
    return { status: 'succeeded', providerStatus: rawStatus, resultUrl }
  }
  if (resultUrl) return { status: 'succeeded', providerStatus: rawStatus, resultUrl }
  return { status: 'running', providerStatus: rawStatus }
}

export type ProviderImageOutput = { url?: string; b64_json?: string }

/** The provider outputs that carry an image, by URL or by bytes. */
export function validProviderImages(value: ProviderImageOutput[] | undefined): ProviderImageOutput[] {
  if (!Array.isArray(value)) return []
  return value.filter((image) => Boolean(requiredText(image.url) || requiredText(image.b64_json)))
}

/** The bytes a provider returned inline, from a data URI or base64; null when it returned neither. */
export function providerImageBytes(
  url: string | null | undefined,
  b64Json: string | null | undefined,
): { bytes: Uint8Array; mimeType: string } | null {
  const cleanUrl = requiredText(url)
  return cleanUrl?.startsWith('data:') ? imageBytesFromDataUri(cleanUrl) : imageBytesFromBase64(requiredText(b64Json))
}

function imageBytesFromDataUri(value: string): { bytes: Uint8Array; mimeType: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value)
  if (!match) throw new Error('Image provider returned an unsupported data URI')
  return imageBytesFromBase64(match[2] ?? null, match[1])
}

function imageBytesFromBase64(value: string | null, mimeType = 'image/png'): { bytes: Uint8Array; mimeType: string } | null {
  if (!value) return null
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return { bytes, mimeType }
  } catch {
    throw new Error('Image provider returned invalid image bytes')
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
