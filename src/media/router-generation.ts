/** Router-backed video, avatar and transcription requests, and the bounded audio fetch transcription reads. */
import { isBlockedFetchHostname } from '../web/fetch-guard'
import { routerResponseErrorMessage, type RouterMediaClient } from './router-client'

const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024
const SUPPORTED_TRANSCRIPTION_FORMATS: ReadonlySet<string> = new Set(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac'])

/** A public http(s) URL a server may fetch; throws naming `field` for anything else. */
export function validatePublicHttpUrl(value: string, field: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${field} must be a valid public URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${field} must use http or https`)
  }
  if (isBlockedFetchHostname(url.hostname)) {
    throw new Error(`${field} must be a public URL`)
  }
  return url.toString()
}

/** Fetch a transcription's audio: public host only, no redirects, audio content, at most 25 MiB. */
export async function fetchBoundedAudio(url: string, options: { signal?: AbortSignal } = {}): Promise<Blob> {
  const safeUrl = validatePublicHttpUrl(url, 'audioUrl')
  const response = await fetch(safeUrl, { signal: options.signal, redirect: 'manual' })
  if (response.status >= 300 && response.status < 400) {
    throw new Error('Audio URL redirects are not allowed')
  }
  if (!response.ok) {
    throw new Error(`Audio fetch failed with ${response.status}`)
  }

  const contentLength = Number(response.headers.get('content-length') ?? '0')
  if (contentLength > MAX_TRANSCRIPTION_BYTES) {
    throw new Error('Audio file is too large')
  }

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
  if (!contentType.startsWith('audio/') && contentType !== 'application/octet-stream') {
    throw new Error('Transcription URL must return audio')
  }

  const blob = await response.blob()
  if (blob.size === 0) throw new Error('Transcription audio URL returned an empty file')
  if (blob.size > MAX_TRANSCRIPTION_BYTES) {
    throw new Error('Audio file is too large')
  }
  return blob
}

export interface RouterVideoRequest {
  model: string
  prompt: string
  /** The router's wire value: some video models use numbers, others publish strings such as `"8s"`. */
  duration?: string | number
  resolution?: string
  aspectRatio?: string
  referenceImageUrl?: string
  callbackUrl?: string
}

export interface RouterAvatarRequest {
  model: string
  prompt: string
  audio_url: string
  image_url?: unknown
  avatar_id?: unknown
  callback_url?: string
}

export interface RouterTranscriptionRequest {
  audioBlob: Blob
  audioUrl: string
  model: string
  language?: unknown
  prompt?: string
  responseFormat?: unknown
  temperature?: unknown
  signal?: AbortSignal
  apiKey: string
}

/** The Router's video, avatar and transcription calls over one bound media client. */
export function createRouterGeneration(client: RouterMediaClient) {
  async function generateVideoViaRouter(
    { model, prompt, duration, resolution, aspectRatio, referenceImageUrl, callbackUrl }: RouterVideoRequest,
    signal: AbortSignal | undefined,
    apiKey: string,
  ): Promise<Record<string, unknown>> {
    return await client.routerJson(
      '/videos/generate',
      {
        model,
        prompt,
        duration,
        resolution,
        aspect_ratio: aspectRatio,
        image_url: referenceImageUrl,
        callback_url: callbackUrl,
      },
      signal,
      apiKey,
    )
  }

  async function generateAvatarViaRouter(
    body: RouterAvatarRequest,
    signal: AbortSignal | undefined,
    apiKey: string,
  ): Promise<Record<string, unknown>> {
    return await client.routerJson('/videos/avatar', { ...body }, signal, apiKey)
  }

  async function transcribeViaRouter({
    audioBlob,
    audioUrl,
    model,
    language,
    prompt,
    responseFormat,
    temperature,
    signal,
    apiKey,
  }: RouterTranscriptionRequest): Promise<{ text?: string }> {
    const format = transcriptionAudioFormat(audioUrl, audioBlob.type)
    const responseFormatText = typeof responseFormat === 'string' && responseFormat.trim() ? responseFormat.trim() : null
    const audioData = bytesToBase64(new Uint8Array(await audioBlob.arrayBuffer()))
    const response = await fetch(client.routerMediaUrl('/audio/transcriptions'), {
      method: 'POST',
      headers: client.routerHeaders(apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model,
        input_audio: { data: audioData, format },
        language,
        prompt,
        response_format: responseFormat,
        temperature,
      }),
      signal,
    })
    if (!response.ok) {
      throw new Error(`Transcription provider failed: ${response.status} ${await routerResponseErrorMessage(response)}`)
    }
    if (isRawTranscriptionResponseFormat(responseFormatText)) {
      return { text: await response.text() }
    }
    return (await response.json()) as { text?: string }
  }

  return { generateVideoViaRouter, generateAvatarViaRouter, transcribeViaRouter }
}

function isRawTranscriptionResponseFormat(value: string | null): boolean {
  const format = value?.toLowerCase()
  return format === 'text' || format === 'srt' || format === 'vtt'
}

function transcriptionAudioFormat(audioUrl: string, contentType: string): string {
  const fromType = contentTypeToAudioFormat(contentType)
  if (fromType) return fromType

  const ext = new URL(audioUrl).pathname.split('.').pop()?.toLowerCase()
  if (ext && SUPPORTED_TRANSCRIPTION_FORMATS.has(ext)) return ext
  throw new Error('Transcription audio must be wav, mp3, flac, m4a, ogg, webm, or aac')
}

function contentTypeToAudioFormat(contentType: string): string | null {
  const type = contentType.toLowerCase().split(';')[0]?.trim()
  if (type === 'audio/wav' || type === 'audio/x-wav') return 'wav'
  if (type === 'audio/mpeg' || type === 'audio/mp3') return 'mp3'
  if (type === 'audio/flac') return 'flac'
  if (type === 'audio/mp4' || type === 'audio/x-m4a') return 'm4a'
  if (type === 'audio/ogg' || type === 'application/ogg') return 'ogg'
  if (type === 'audio/webm' || type === 'video/webm') return 'webm'
  if (type === 'audio/aac') return 'aac'
  return null
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}

/**
 * Where the Router posts provider job updates for this deployment, or
 * undefined when webhooks are off. `TCLOUD_WEBHOOK_SECRET` turns them on;
 * `TCLOUD_WEBHOOKS_ENABLED` without the secret is a configuration error. The
 * origin is `PUBLIC_ORIGIN`, else `APP_ORIGIN`, else the request's own.
 */
export function tcloudWebhookCallbackUrl(env: Record<string, unknown> | undefined, requestUrl: string): string | undefined {
  const secret = configuredText(env?.TCLOUD_WEBHOOK_SECRET)
  const enabled = secret || truthy(env?.TCLOUD_WEBHOOKS_ENABLED)
  if (!enabled) return undefined
  if (!secret) throw new Error('TCLOUD_WEBHOOK_SECRET is required when tcloud webhooks are enabled')
  const origin = configuredText(env?.PUBLIC_ORIGIN) ?? configuredText(env?.APP_ORIGIN) ?? new URL(requestUrl).origin
  return `${origin.replace(/\/+$/, '')}/api/webhooks/tcloud`
}

function configuredText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function truthy(value: unknown): boolean {
  return value === true || (typeof value === 'string' && /^(1|true|yes|on)$/i.test(value.trim()))
}
