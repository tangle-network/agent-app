import { describe, expect, it } from 'vitest'

import {
  FALLBACK_VIDEO_MODEL_OPTIONS,
  curateComposerModels,
  imageToVideoSibling,
  optionChoices,
  optionDefault,
  reconcileOptionValues,
  resolveComposerOptions,
  supportsCustomImageSize,
  textToVideoSibling,
  validateCustomImageSize,
} from '../../src/studio/model-options'
import type { GenerationType, MediaModelOption } from '../../src/studio/generation'

function model(id: string, type: GenerationType = 'video'): MediaModelOption {
  return { id, name: id, type, status: 'available' }
}

describe('fallback video model options', () => {
  it('keeps provider-sensitive values wire-exact', () => {
    const seedance = FALLBACK_VIDEO_MODEL_OPTIONS['bytedance/seedance-2.0/text-to-video']
    expect(seedance?.duration).toMatchObject({ default: 'auto' })
    expect(seedance?.duration?.values).toContain('4')
    expect(seedance?.duration?.values).not.toContain(4)

    expect(FALLBACK_VIDEO_MODEL_OPTIONS['kling/kling-v1-6']?.duration?.values).toEqual([5, 10])
    expect(FALLBACK_VIDEO_MODEL_OPTIONS['fal-ai/veo3.1']?.duration?.values).toEqual(['4s', '6s', '8s'])
    expect(FALLBACK_VIDEO_MODEL_OPTIONS['kling/kling-v2-master']?.resolution).toEqual({ supported: false })
    expect(FALLBACK_VIDEO_MODEL_OPTIONS['runway/gen4.5']?.resolution).toEqual({ supported: false })
  })
})

describe('resolveComposerOptions', () => {
  it('prefers catalog metadata and preserves honest unknowns', () => {
    const catalogOptions = { duration: { values: [3], default: 3 } } as const
    expect(resolveComposerOptions({
      type: 'video',
      modelId: 'kling/kling-v1-6',
      catalogOptions,
    })).toBe(catalogOptions)
    expect(resolveComposerOptions({ type: 'video', modelId: 'ltx-video' })).toBeUndefined()
  })

  it('resolves image and audio tables through safe provider prefixes', () => {
    expect(resolveComposerOptions({ type: 'image', modelId: 'openai/gpt-image-2' })?.n?.values).toEqual([1, 2, 4, 8])
    expect(resolveComposerOptions({ type: 'speech', modelId: 'openai/tts-1' })?.voice?.default).toBe('alloy')
    expect(resolveComposerOptions({ type: 'video', modelId: 'unknown/seedance-2.0/text-to-video' })).toBeUndefined()
  })
})

describe('curateComposerModels', () => {
  it('keeps only gpt-image-2 in the image lane', () => {
    const models = [model('gpt-image-2', 'image'), model('openai/gpt-image-2', 'image'), model('imagen-4', 'image')]
    expect(curateComposerModels('image', models).map(({ id }) => id)).toEqual(['gpt-image-2', 'openai/gpt-image-2'])
  })

  it('drops sora and image-to-video siblings while leaving speech unchanged', () => {
    const videoModels = [
      model('sora-2'),
      model('bytedance/seedance-2.0/text-to-video'),
      model('bytedance/seedance-2.0/image-to-video'),
      model('runway/gen4.5'),
    ]
    expect(curateComposerModels('video', videoModels).map(({ id }) => id)).toEqual([
      'bytedance/seedance-2.0/text-to-video',
      'runway/gen4.5',
    ])

    const speechModels = [model('tts-1', 'speech'), model('voxtral-mini', 'speech')]
    expect(curateComposerModels('speech', speechModels)).toEqual(speechModels)
  })
})

describe('video sibling mapping', () => {
  it('round-trips the verified Seedance pair', () => {
    const textModel = 'bytedance/seedance-2.0/text-to-video'
    const imageModel = imageToVideoSibling(textModel)
    expect(imageModel).toBe('bytedance/seedance-2.0/image-to-video')
    expect(textToVideoSibling(imageModel ?? '')).toBe(textModel)
  })
})

describe('custom image size', () => {
  it('accepts valid boundaries and rejects each invalid constraint', () => {
    expect(validateCustomImageSize(1536, 1024)).toEqual({ ok: true })
    expect(validateCustomImageSize(3072, 1024)).toEqual({ ok: true })
    expect(validateCustomImageSize(1000, 1000)).toMatchObject({ ok: false, reason: 'Each side must be a multiple of 16.' })
    expect(validateCustomImageSize(4096, 1024)).toMatchObject({ ok: false, reason: 'The long edge must be 3840 pixels or less.' })
    expect(validateCustomImageSize(3840, 1024)).toMatchObject({ ok: false, reason: 'The aspect ratio must be between 1:3 and 3:1.' })
    expect(supportsCustomImageSize('openai/gpt-image-2')).toBe(true)
    expect(supportsCustomImageSize('imagen-4')).toBe(false)
  })
})

describe('option state helpers', () => {
  it('derives defaults and renderable choices', () => {
    expect(optionDefault({ default: 'auto', values: ['4'] })).toBe('auto')
    expect(optionDefault({ values: ['4', '5'] })).toBe('4')
    expect(optionDefault({ min: 2, max: 4 })).toBe(2)
    expect(optionChoices({ min: 2, max: 4 })).toEqual([2, 3, 4])
  })

  it('resets illegal values, keeps legal values, and drops unsupported fields', () => {
    const seedance = FALLBACK_VIDEO_MODEL_OPTIONS['bytedance/seedance-2.0/text-to-video']
    const veo = FALLBACK_VIDEO_MODEL_OPTIONS['fal-ai/veo3.1']
    const selected = reconcileOptionValues(seedance, { duration: 'auto', aspect_ratio: '16:9', resolution: '720p' })
    const remapped = reconcileOptionValues(veo, selected)
    expect(remapped.duration).toBe('8s')
    expect(remapped.aspect_ratio).toBe('16:9')

    const kling = reconcileOptionValues(FALLBACK_VIDEO_MODEL_OPTIONS['kling/kling-v2-master'], remapped)
    expect(kling).not.toHaveProperty('resolution')
  })

  it('keeps valid custom sizes only when the caller allows them', () => {
    const options = resolveComposerOptions({ type: 'image', modelId: 'gpt-image-2' })
    expect(reconcileOptionValues(options, { size: '1920x1088' }, { allowCustomSize: true }).size).toBe('1920x1088')
    expect(reconcileOptionValues(options, { size: '1000x1000' }, { allowCustomSize: true }).size).toBe('auto')
    // Without the caller's opt-in, an off-enum size resets even when it passes
    // the custom-size rule — the rule is per-model and the caller owns it.
    expect(reconcileOptionValues(options, { size: '1920x1088' }).size).toBe('auto')
  })
})

describe('audio model options', () => {
  it('publishes verified voices and keeps unsupported providers honest', () => {
    expect(resolveComposerOptions({ type: 'speech', modelId: 'tts-1' })?.voice?.values).toHaveLength(9)
    expect(resolveComposerOptions({ type: 'speech', modelId: 'gpt-4o-mini-tts' })?.voice?.values).toHaveLength(13)

    const google = resolveComposerOptions({ type: 'speech', modelId: 'gemini-2.5-flash-preview-tts' })
    expect(google?.voice?.values).toEqual(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'])
    expect(google?.speed).toEqual({ supported: false })
    expect(resolveComposerOptions({ type: 'speech', modelId: 'voxtral-mini' })).toBeUndefined()
  })
})
