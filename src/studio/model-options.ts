import type { GenerationType, MediaModelOption } from './generation'

/** A wire-typed value accepted by a model option. */
export type ModelOptionValue = string | number | boolean

/** Per-parameter option metadata, structurally identical to tangle-router's
 *  `ModelOptionMetadata` (lib/model-options.ts, shipped in router PR #429).
 *  `supported: false` means the model lacks or ignores the parameter.
 *  `values` is the exact wire-typed enum; `min` and `max` are inclusive.
 *  `default` applies when the caller omits the parameter. An absent entry or
 *  options object means unknown, so consumers must not invent a value. */
export interface ModelOptionMetadata {
  supported?: boolean
  values?: readonly ModelOptionValue[]
  min?: number
  max?: number
  default?: ModelOptionValue
}

/** Per-parameter model option metadata keyed by the provider's wire field. */
export type ModelOptionsMetadata = Readonly<Record<string, ModelOptionMetadata>>

const SEEDANCE_2_0: ModelOptionsMetadata = {
  duration: {
    values: ['auto', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'],
    default: 'auto',
  },
  resolution: { values: ['480p', '720p', '1080p', '4k'], default: '720p' },
  aspect_ratio: { values: ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], default: 'auto' },
  audio: { default: true },
}

// These values mirror tangle-router VIDEO_MODEL_OPTIONS from PR #429,
// observedAt 2026-08-19. Catalog-provided live options always win.
/** Fallback video options matching tangle-router's wire-exact metadata. */
export const FALLBACK_VIDEO_MODEL_OPTIONS: Readonly<Record<string, ModelOptionsMetadata>> = {
  'runway/gen4.5': {
    duration: { min: 2, max: 10, default: 5 },
    aspect_ratio: { values: ['16:9', '9:16'], default: '16:9' },
    resolution: { supported: false },
    audio: { supported: false },
  },
  'runway/gen4_turbo': {
    duration: { min: 2, max: 10, default: 5 },
    aspect_ratio: { values: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'], default: '16:9' },
    resolution: { supported: false },
    audio: { supported: false },
  },
  'kling/kling-v1-6': {
    duration: { values: [5, 10], default: 5 },
    aspect_ratio: { values: ['16:9', '9:16', '1:1'], default: '16:9' },
    resolution: { supported: false },
    audio: { supported: false },
    mode: { values: ['std', 'pro'], default: 'std' },
  },
  'kling/kling-v2-master': {
    duration: { values: [5, 10], default: 5 },
    aspect_ratio: { values: ['16:9', '9:16', '1:1'], default: '16:9' },
    resolution: { supported: false },
    audio: { supported: false },
    mode: { supported: false },
  },
  'bytedance/seedance-2.0/text-to-video': SEEDANCE_2_0,
  'bytedance/seedance-2.0/image-to-video': SEEDANCE_2_0,
  'fal-ai/kling-video/v3/pro/text-to-video': {
    duration: { values: ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'], default: '5' },
    resolution: { supported: false },
    aspect_ratio: { values: ['16:9', '9:16', '1:1'], default: '16:9' },
    audio: { default: true },
  },
  'fal-ai/veo3.1': {
    duration: { values: ['4s', '6s', '8s'], default: '8s' },
    resolution: { values: ['720p', '1080p', '4k'], default: '720p' },
    aspect_ratio: { values: ['16:9', '9:16'], default: '16:9' },
    audio: { default: true },
  },
  'xai/grok-imagine-video/text-to-video': {
    duration: { min: 1, max: 15, default: 6 },
    resolution: { values: ['480p', '720p'], default: '720p' },
    aspect_ratio: { values: ['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16'], default: '16:9' },
    audio: { supported: false },
  },
}

// Source: provider research recorded in router #420 and agent-app #449 on
// 2026-08-18. Live catalog options remain authoritative when present.
const IMAGE_MODEL_OPTIONS: Readonly<Record<string, ModelOptionsMetadata>> = {
  'gpt-image-2': {
    size: { values: ['auto', '1024x1024', '1536x1024', '1024x1536'], default: 'auto' },
    quality: { values: ['low', 'medium', 'high', 'auto'], default: 'auto' },
    n: { values: [1, 2, 4, 8], default: 1 },
  },
}

const OPENAI_TTS_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'] as const
const OPENAI_GPT4O_MINI_TTS_VOICES = [...OPENAI_TTS_VOICES, 'ballad', 'cedar', 'marin', 'verse'] as const
// These aliases are the router's GEMINI_VOICE_MAP keys. The router translates
// them to Kore, Puck, Charon, Algenib, Aoede, and Leda respectively.
const GOOGLE_TTS_VOICE_ALIASES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const

const OPENAI_AUDIO_MODEL_OPTIONS: Readonly<Record<string, ModelOptionsMetadata>> = {
  'tts-1': {
    voice: { values: OPENAI_TTS_VOICES, default: 'alloy' },
    speed: { min: 0.25, max: 4, default: 1 },
  },
  'tts-1-hd': {
    voice: { values: OPENAI_TTS_VOICES, default: 'alloy' },
    speed: { min: 0.25, max: 4, default: 1 },
  },
  'gpt-4o-mini-tts': {
    voice: { values: OPENAI_GPT4O_MINI_TTS_VOICES, default: 'alloy' },
    speed: { min: 0.25, max: 4, default: 1 },
  },
}

const GOOGLE_AUDIO_MODEL_OPTIONS: ModelOptionsMetadata = {
  voice: { values: GOOGLE_TTS_VOICE_ALIASES, default: 'alloy' },
  speed: { supported: false },
}

// Mistral's preset voices are enumerable only through its authenticated
// /v1/audio/voices API; no publicly verifiable list existed at research time.
// Unknown means show nothing invented, so Voxtral uses the router's provider
// default (gb_jane_neutral) until router #420 publishes live catalog options.

/** UI constraints for a custom gpt-image-2 size. */
export const GPT_IMAGE_2_CUSTOM_SIZE = { multipleOf: 16, maxLongEdge: 3840, maxRatio: 3 } as const

/** Validate a custom gpt-image-2 size against its published UI constraints. */
export function validateCustomImageSize(width: number, height: number): { ok: true } | { ok: false; reason: string } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return { ok: false, reason: 'Width and height must be positive integers.' }
  }
  if (width % GPT_IMAGE_2_CUSTOM_SIZE.multipleOf !== 0 || height % GPT_IMAGE_2_CUSTOM_SIZE.multipleOf !== 0) {
    return { ok: false, reason: 'Each side must be a multiple of 16.' }
  }
  if (Math.max(width, height) > GPT_IMAGE_2_CUSTOM_SIZE.maxLongEdge) {
    return { ok: false, reason: 'The long edge must be 3840 pixels or less.' }
  }
  if (Math.max(width / height, height / width) > GPT_IMAGE_2_CUSTOM_SIZE.maxRatio) {
    return { ok: false, reason: 'The aspect ratio must be between 1:3 and 3:1.' }
  }
  return { ok: true }
}

const KNOWN_PROVIDER_ALIASES = new Set([
  'openai',
  'google',
  'gemini',
  'fal',
  'fal-ai',
  'runway',
  'kling',
  'bytedance',
  'xai',
])

function bareSingleSlashId(modelId: string): string | undefined {
  const segments = modelId.split('/')
  if (segments.length !== 2 || !KNOWN_PROVIDER_ALIASES.has(segments[0] ?? '')) return undefined
  return segments[1]
}

function audioOptions(modelId: string, provider?: string): ModelOptionsMetadata | undefined {
  const bareId = bareSingleSlashId(modelId) ?? modelId
  const exact = OPENAI_AUDIO_MODEL_OPTIONS[modelId] ?? OPENAI_AUDIO_MODEL_OPTIONS[bareId]
  if (exact) return exact

  const normalizedProvider = provider?.toLowerCase()
  if (
    (bareId.toLowerCase().startsWith('gemini') && bareId.toLowerCase().includes('tts'))
    || normalizedProvider === 'google'
    || normalizedProvider === 'gemini'
  ) return GOOGLE_AUDIO_MODEL_OPTIONS

  return undefined
}

/** Resolve live catalog options first, then exact or safe single-prefix fallbacks. */
export function resolveComposerOptions(input: {
  type: 'image' | 'video' | 'speech'
  modelId: string
  provider?: string
  catalogOptions?: ModelOptionsMetadata
}): ModelOptionsMetadata | undefined {
  if (input.catalogOptions) return input.catalogOptions
  if (input.type === 'speech') return audioOptions(input.modelId, input.provider)

  const table = input.type === 'image' ? IMAGE_MODEL_OPTIONS : FALLBACK_VIDEO_MODEL_OPTIONS
  const exact = table[input.modelId]
  if (exact) return exact

  // Only a known provider prefix on an id with exactly one slash is stripped;
  // multi-slash fal ids must remain whole.
  const bareId = bareSingleSlashId(input.modelId)
  return bareId ? table[bareId] : undefined
}

/** Return whether a model supports the gpt-image-2 custom-size rule. */
export function supportsCustomImageSize(modelId: string): boolean {
  return modelId === 'gpt-image-2' || bareSingleSlashId(modelId) === 'gpt-image-2'
}

/** Map verified text-to-video model ids to their image-to-video siblings. */
export const IMAGE_TO_VIDEO_SIBLINGS: Readonly<Record<string, string>> = {
  'bytedance/seedance-2.0/text-to-video': 'bytedance/seedance-2.0/image-to-video',
}

/** Resolve a verified image-to-video sibling for a text-to-video model. */
export function imageToVideoSibling(modelId: string): string | undefined {
  return IMAGE_TO_VIDEO_SIBLINGS[modelId]
}

/** Resolve the verified text-to-video sibling for an image-to-video model. */
export function textToVideoSibling(modelId: string): string | undefined {
  return Object.entries(IMAGE_TO_VIDEO_SIBLINGS).find(([, sibling]) => sibling === modelId)?.[0]
}

/** Curate catalog models for the issue #449 composer lanes. */
export function curateComposerModels(
  type: GenerationType,
  models: MediaModelOption[],
): MediaModelOption[] {
  if (type === 'image') return models.filter((model) => supportsCustomImageSize(model.id))
  if (type === 'video') {
    const imageToVideoIds = new Set(Object.values(IMAGE_TO_VIDEO_SIBLINGS))
    return models.filter((model) => !model.id.toLowerCase().includes('sora') && !imageToVideoIds.has(model.id))
  }
  return models
}

/** Resolve an option default from its default, values, or lower bound. */
export function optionDefault(meta: ModelOptionMetadata): ModelOptionValue | undefined {
  return meta.default ?? meta.values?.[0] ?? meta.min
}

/** Return exact enum choices or an inclusive integer range. */
export function optionChoices(meta: ModelOptionMetadata): readonly ModelOptionValue[] {
  if (meta.values) return meta.values
  if (meta.min == null || meta.max == null) return []
  const values: number[] = []
  for (let value = Math.ceil(meta.min); value <= Math.floor(meta.max); value += 1) values.push(value)
  return values
}

function isCustomSize(value: ModelOptionValue): boolean {
  if (typeof value !== 'string') return false
  const match = /^(\d+)x(\d+)$/.exec(value)
  if (!match) return false
  return validateCustomImageSize(Number(match[1]), Number(match[2])).ok
}

function isLegalOptionValue(meta: ModelOptionMetadata, value: ModelOptionValue): boolean {
  if (meta.values) return meta.values.includes(value)
  if (typeof value === 'number' && meta.min != null && meta.max != null) {
    return value >= meta.min && value <= meta.max
  }
  return meta.min == null && meta.max == null
}

/** Reconcile selections against supported options and their wire-typed defaults.
 *  `allowCustomSize` keeps a legal off-enum `WxH` size selection (gpt-image-2's
 *  custom-size rule) — the caller decides via {@link supportsCustomImageSize},
 *  so the check holds even when the options came from the live catalog. */
export function reconcileOptionValues(
  options: ModelOptionsMetadata | undefined,
  current: Readonly<Record<string, ModelOptionValue>>,
  opts?: { allowCustomSize?: boolean },
): Record<string, ModelOptionValue> {
  if (!options) return {}
  const reconciled: Record<string, ModelOptionValue> = {}
  for (const [key, meta] of Object.entries(options)) {
    if (meta.supported === false) continue
    const selected = current[key]
    const customSizeIsLegal = key === 'size'
      && selected !== undefined
      && opts?.allowCustomSize === true
      && isCustomSize(selected)
    const selectionIsLegal = selected !== undefined
      && (isLegalOptionValue(meta, selected) || customSizeIsLegal)
    const next = selectionIsLegal ? selected : optionDefault(meta)
    if (next !== undefined) reconciled[key] = next
  }
  return reconciled
}
