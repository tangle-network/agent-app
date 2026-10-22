/**
 * The direct media-generation request: its body shape, the checks every
 * generation type runs before any provider call, and the model a request
 * resolves to. Product pricing, defaults and extra body fields stay with the
 * product, which passes its defaults in and extends the body type.
 */
import { isBlockedFetchHostname } from '../web/fetch-guard'
import type { GenerationType } from '../studio/generation'

/** The request body every media product accepts; a product extends it with its own fields. */
export interface GenerateRequestBody {
  workspaceId: string
  threadId?: string
  clientRequestId?: string
  type: GenerationType
  prompt?: string
  negativePrompt?: string
  outputPath?: string
  model?: string
  // image options
  size?: string
  quality?: string
  n?: number
  // video options
  /** The media catalog publishes both numeric and string durations. */
  duration?: string | number
  resolution?: string
  aspectRatio?: string
  referenceImageUrl?: string
  // speech options
  voice?: string
  // avatar options
  audioUrl?: string
  imageUrl?: string
  avatarId?: string
  // transcription options
  language?: string
  responseFormat?: string
  temperature?: number
}

/** The request's checked inputs, recorded on the generation row. */
export type GenerateInputs = Record<string, unknown> & {
  promptLabel: string
  audioUrl?: string
  imageUrl?: string
  avatarId?: string
  language?: string
  responseFormat?: string
  temperature?: number
}

export type Checked<T> = { succeeded: true; value: T } | { succeeded: false; error: string }

const MIN_IMAGE_COUNT = 1
const MAX_IMAGE_COUNT = 4

export function requiredText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function validateGenerateRequest(
  type: GenerationType,
  body: GenerateRequestBody,
  prompt: string,
): Checked<GenerateInputs> {
  if (type !== 'transcription' && type !== 'avatar' && !prompt) {
    return { succeeded: false, error: 'prompt is required' }
  }

  if (type === 'avatar') {
    const audioUrl = requiredHttpsUrl(body.audioUrl, 'audioUrl')
    if (!audioUrl.succeeded) return audioUrl
    const imageUrl = optionalHttpsUrl(body.imageUrl, 'imageUrl')
    if (!imageUrl.succeeded) return imageUrl
    return {
      succeeded: true,
      value: {
        promptLabel: prompt || audioUrl.value,
        audioUrl: audioUrl.value,
        imageUrl: imageUrl.value,
        avatarId: body.avatarId?.trim() || undefined,
      },
    }
  }

  if (type === 'transcription') {
    const audioUrl = requiredHttpsUrl(body.audioUrl, 'audioUrl')
    if (!audioUrl.succeeded) return audioUrl
    return {
      succeeded: true,
      value: {
        promptLabel: prompt || audioUrl.value,
        audioUrl: audioUrl.value,
        language: body.language?.trim() || undefined,
        responseFormat: body.responseFormat?.trim() || undefined,
        temperature: numberValue(body.temperature),
      },
    }
  }

  if (type === 'video') {
    const referenceImageUrl = optionalHttpsUrl(body.referenceImageUrl, 'referenceImageUrl')
    if (!referenceImageUrl.succeeded) return referenceImageUrl
    return {
      succeeded: true,
      value: {
        promptLabel: prompt,
        duration: body.duration,
        resolution: body.resolution,
        aspectRatio: body.aspectRatio?.trim() || undefined,
        referenceImageUrl: referenceImageUrl.value,
      },
    }
  }

  return {
    succeeded: true,
    value: {
      promptLabel: prompt,
      size: body.size,
      quality: body.quality,
      n: body.n,
      duration: body.duration,
      resolution: body.resolution,
      voice: body.voice,
    },
  }
}

/** The images requested: absent means one; anything but an integer in range is refused. */
export function imageCountForRequest(value: unknown): Checked<number> {
  if (value == null) return { succeeded: true, value: 1 }
  const count = typeof value === 'number' ? value : Number.NaN
  if (!Number.isInteger(count) || count < MIN_IMAGE_COUNT || count > MAX_IMAGE_COUNT) {
    return { succeeded: false, error: `Images must be an integer between ${MIN_IMAGE_COUNT} and ${MAX_IMAGE_COUNT}` }
  }
  return { succeeded: true, value: count }
}

/** The model the request names, else the product's default for its type. */
export function modelForRequest(
  type: GenerationType,
  body: { model?: string },
  defaults: Record<GenerationType, string>,
): string {
  return body.model?.trim() || defaults[type]
}

/** A required https URL that does not point at this machine or a private network. */
function requiredHttpsUrl(value: unknown, field: string): Checked<string> {
  const text = requiredText(value)
  if (!text) return { succeeded: false, error: `${field} is required` }
  return validateExternalHttpsUrl(text, field)
}

export function optionalHttpsUrl(value: unknown, field: string): Checked<string | undefined> {
  const text = requiredText(value)
  if (!text) return { succeeded: true, value: undefined }
  return validateExternalHttpsUrl(text, field)
}

function validateExternalHttpsUrl(value: string, field: string): Checked<string> {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') {
      return { succeeded: false, error: `${field} must be an https URL` }
    }
    if (isBlockedFetchHostname(url.hostname)) {
      return { succeeded: false, error: `${field} must not point to localhost or a private network address` }
    }
    return { succeeded: true, value }
  } catch {
    return { succeeded: false, error: `${field} must be a valid URL` }
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
