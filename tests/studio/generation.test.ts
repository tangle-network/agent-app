/**
 * Unit coverage for the studio generation model — the pure merge/optimistic/
 * batch/model-selection logic the composer and the `useStudioGenerations` hook
 * compose. These are the non-obvious, easy-to-regress pieces (dual-key dedup,
 * batch grouping and NaN guards) exercised with fake
 * Generation fixtures; the React hook layers polling on top of them.
 */

import { describe, expect, it } from 'vitest'

import {
  type Generation,
  type GenerationRequestFields,
  type MediaModelCatalogResponse,
  aspectRatioFromOptions,
  buildGenerationRequestBody,
  defaultVaultPathFor,
  failedOptimisticGeneration,
  generationAspectRatio,
  generationAssetId,
  generationBatchKey,
  generationError,
  generationMergeKey,
  generationSpecSegments,
  generationStatus,
  generationVaultPath,
  generationsInBatch,
  isGenerationType,
  isLocalGeneration,
  laneUnavailable,
  latestBatchOf,
  mergeGenerationPages,
  mergeLiveGeneration,
  mergeLoaderAndLive,
  normalizeImageCount,
  normalizeVaultPath,
  optimisticGeneration,
  outputPathFor,
  preferredModelId,
  selectedModelsWithDefaults,
  userSafeGenerationMessage,
} from '../../src/studio/generation'
import { FALLBACK_VIDEO_MODEL_OPTIONS } from '../../src/studio/model-options'

function gen(partial: Partial<Generation> & { id: string }): Generation {
  return {
    type: 'image',
    prompt: '',
    result: null,
    model: null,
    cost: null,
    createdAt: null,
    metadata: null,
    ...partial,
  }
}

function reqFields(partial: Partial<GenerationRequestFields> = {}): GenerationRequestFields {
  return {
    workspaceId: 'ws',
    clientRequestId: 'req-1',
    type: 'image',
    model: 'm',
    prompt: ' hello ',
    image: { size: '1024x1024', quality: 'high', count: 1 },
    video: { duration: '6', resolution: '720p', aspectRatio: '16:9', referenceImageUrl: '' },
    speech: { voice: 'alloy' },
    avatar: { audioUrl: '', imageUrl: '', avatarId: '' },
    transcription: { audioUrl: '', language: '', responseFormat: 'json', temperature: '0' },
    ...partial,
  }
}

describe('generationStatus / generationError', () => {
  it('reads metadata.generationStatus, falling back to result presence', () => {
    expect(generationStatus(gen({ id: 'a', metadata: { generationStatus: 'running' } }))).toBe('running')
    expect(generationStatus(gen({ id: 'b', result: 'https://x/y.png' }))).toBe('succeeded')
    expect(generationStatus(gen({ id: 'c' }))).toBe('pending')
  })

  it('surfaces provider/storage errors and sanitizes provider messages', () => {
    expect(generationError(gen({ id: 'a', metadata: { providerError: 'model overloaded' } }))).toBe('model overloaded')
    expect(generationError(gen({ id: 'b', metadata: { providerError: 'missing api_key in env' } }))).toBe('Generation failed')
    expect(generationError(gen({ id: 'c', metadata: { storageError: 'disk full' } }))).toBe('disk full')
    expect(generationError(gen({ id: 'd' }))).toBeNull()
  })
})

describe('userSafeGenerationMessage', () => {
  it('redacts credential-shaped messages but keeps the tangle-key hint and plain text', () => {
    expect(userSafeGenerationMessage(undefined)).toBe('Generation failed')
    expect(userSafeGenerationMessage('Tangle API key is invalid or expired')).toBe('Tangle API key is invalid or expired')
    expect(userSafeGenerationMessage('your secret token leaked')).toBe('Generation failed')
    expect(userSafeGenerationMessage('rate limited, try again')).toBe('rate limited, try again')
  })
})

describe('generationMergeKey', () => {
  it('prefers batch slot key, falls back to clientRequestId, else null', () => {
    expect(generationMergeKey(gen({ id: 'a', metadata: { batchId: 'b1', outputIndex: 2 } }))).toBe('b1:2')
    expect(generationMergeKey(gen({ id: 'b', metadata: { clientRequestId: 'r1' } }))).toBe('r1')
    expect(generationMergeKey(gen({ id: 'c' }))).toBeNull()
  })
})

describe('mergeLiveGeneration', () => {
  it('prepends an unseen generation', () => {
    const out = mergeLiveGeneration([gen({ id: 'a' })], gen({ id: 'b' }))
    expect(out.map((g) => g.id)).toEqual(['b', 'a'])
  })

  it('replaces in place when id matches', () => {
    const out = mergeLiveGeneration([gen({ id: 'a', prompt: 'old' })], gen({ id: 'a', prompt: 'new' }))
    expect(out).toHaveLength(1)
    expect(out[0]?.prompt).toBe('new')
  })

  it('replaces by merge key when ids differ', () => {
    const local = gen({ id: 'local-r1', metadata: { clientRequestId: 'r1' } })
    const server = gen({ id: 'srv', metadata: { clientRequestId: 'r1' } })
    const out = mergeLiveGeneration([local], server)
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe('srv')
  })
})

describe('mergeLoaderAndLive', () => {
  it('returns the loader list unchanged when nothing is live', () => {
    const loader = [gen({ id: 'a' })]
    expect(mergeLoaderAndLive(loader, [])).toBe(loader)
  })

  it('dedups an optimistic local row against its committed loader row by merge key', () => {
    const committed = gen({ id: 'srv', metadata: { clientRequestId: 'r1' } })
    const local = gen({ id: 'local-r1', metadata: { clientRequestId: 'r1' } })
    const out = mergeLoaderAndLive([committed], [local])
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe('srv')
  })

  it('leads with live rows and appends the remaining loader rows', () => {
    const out = mergeLoaderAndLive([gen({ id: 'old' })], [gen({ id: 'new' })])
    expect(out.map((g) => g.id)).toEqual(['new', 'old'])
  })
})

describe('latestBatchOf', () => {
  it('groups the leading clientRequestId batch and sorts by output index', () => {
    const batch = latestBatchOf([
      gen({ id: 'g2', metadata: { clientRequestId: 'r1', outputIndex: 2 } }),
      gen({ id: 'g0', metadata: { clientRequestId: 'r1', outputIndex: 0 } }),
      gen({ id: 'other', metadata: { clientRequestId: 'r2' } }),
    ])
    expect(batch.map((g) => g.id)).toEqual(['g0', 'g2'])
  })

  it('returns just the leading item when it has no request id, and [] when empty', () => {
    expect(latestBatchOf([gen({ id: 'solo' }), gen({ id: 'x' })]).map((g) => g.id)).toEqual(['solo'])
    expect(latestBatchOf([])).toEqual([])
  })
})

describe('optimisticGeneration / failedOptimisticGeneration', () => {
  it('builds a batch slot with a local- id when an output index is given', () => {
    const g = optimisticGeneration({ type: 'image', prompt: 'p', clientRequestId: 'r1', outputIndex: 1, outputCount: 4 })
    expect(g.id).toBe('local-r1-1')
    expect(isLocalGeneration(g)).toBe(true)
    expect(g.metadata?.batchId).toBe('r1')
    expect(generationStatus(g)).toBe('pending')
  })

  it('builds a single local row (no batchId) when no output index is given', () => {
    const g = optimisticGeneration({ type: 'video', prompt: 'p', clientRequestId: 'r1' })
    expect(g.id).toBe('local-r1')
    expect(g.metadata?.batchId).toBeUndefined()
  })

  it('preserves the prior row shape when no aspect ratio is passed', () => {
    const g = optimisticGeneration({
      type: 'video',
      prompt: 'p',
      model: 'video-model',
      clientRequestId: 'r1',
    })
    expect(g).toEqual({
      id: 'local-r1',
      type: 'video',
      prompt: 'p',
      result: null,
      model: 'video-model',
      cost: null,
      createdAt: g.createdAt,
      metadata: {
        generationStatus: 'pending',
        provider: 'video',
        clientRequestId: 'r1',
        batchId: undefined,
        outputIndex: undefined,
        outputCount: undefined,
      },
    })
    expect(g.metadata).not.toHaveProperty('aspectRatio')
  })

  it('stores a finite positive optimistic aspect ratio', () => {
    const g = optimisticGeneration({ type: 'video', prompt: 'p', clientRequestId: 'r1' }, 16 / 9)
    expect(g.metadata?.aspectRatio).toBe(16 / 9)
  })

  it('marks an optimistic row failed', () => {
    const g = failedOptimisticGeneration(optimisticGeneration({ type: 'image', prompt: 'p', clientRequestId: 'r1' }))
    expect(generationStatus(g)).toBe('failed')
    expect(generationError(g)).toBe('Generation failed')
  })
})

describe('studio library generation helpers', () => {
  it('resolves batch keys by batchId, clientRequestId, then id and skips empty strings', () => {
    expect(generationBatchKey(gen({ id: 'a', metadata: { batchId: 'batch', clientRequestId: 'request' } }))).toBe('batch')
    expect(generationBatchKey(gen({ id: 'b', metadata: { batchId: ' ', clientRequestId: 'request' } }))).toBe('request')
    expect(generationBatchKey(gen({ id: 'c', metadata: { batchId: '', clientRequestId: '' } }))).toBe('c')
  })

  it('filters batch rows and orders output indexes before stable missing-index rows', () => {
    const rows = generationsInBatch([
      gen({ id: 'missing-a', metadata: { batchId: 'batch' } }),
      gen({ id: 'other', metadata: { batchId: 'other', outputIndex: 0 } }),
      gen({ id: 'two', metadata: { batchId: 'batch', outputIndex: 2 } }),
      gen({ id: 'zero', metadata: { batchId: 'batch', outputIndex: 0 } }),
      gen({ id: 'missing-b', metadata: { batchId: 'batch' } }),
    ], 'batch')
    expect(rows.map((row) => row.id)).toEqual(['zero', 'two', 'missing-a', 'missing-b'])
  })

  it('reads only a non-empty string asset id', () => {
    expect(generationAssetId(gen({ id: 'a', metadata: { assetId: 'asset-1' } }))).toBe('asset-1')
    expect(generationAssetId(gen({ id: 'b', metadata: { assetId: '' } }))).toBeNull()
    expect(generationAssetId(gen({ id: 'c', metadata: { assetId: 42 } }))).toBeNull()
    expect(generationAssetId(gen({ id: 'd' }))).toBeNull()
  })

  it('resolves numeric, size, unicode-size, and string aspect ratios before lane defaults', () => {
    expect(generationAspectRatio(gen({ id: 'numeric', metadata: { aspectRatio: 1.234567 } }))).toBe(1.2346)
    expect(generationAspectRatio(gen({ id: 'ascii', metadata: { size: '1536x1024' } }))).toBe(1.5)
    expect(generationAspectRatio(gen({ id: 'unicode', metadata: { size: '1536×1024' } }))).toBe(1.5)
    expect(generationAspectRatio(gen({ id: 'portrait', metadata: { aspectRatio: '9:16' } }))).toBe(0.5625)
    expect(generationAspectRatio(gen({ id: 'image', type: 'image' }))).toBe(1)
    expect(generationAspectRatio(gen({ id: 'video', type: 'video' }))).toBe(1.7778)
    expect(generationAspectRatio(gen({ id: 'speech', type: 'speech' }))).toBe(3.2)
    expect(generationAspectRatio(gen({ id: 'audio', type: 'audio' }))).toBe(3.2)
    expect(generationAspectRatio(gen({ id: 'unknown', type: 'unknown' }))).toBe(1)
  })

  it('derives aspect ratios from lane options', () => {
    expect(aspectRatioFromOptions('image', { size: '1536x1024' })).toBe(1.5)
    expect(aspectRatioFromOptions('image', { size: '1536×1024' })).toBe(1.5)
    expect(aspectRatioFromOptions('video', { aspectRatio: '9:16' })).toBe(0.5625)
    expect(aspectRatioFromOptions('speech', {})).toBe(3.2)
    expect(aspectRatioFromOptions('image', { size: 'large' })).toBeUndefined()
    expect(aspectRatioFromOptions('video', { aspectRatio: 'wide' })).toBeUndefined()
    expect(aspectRatioFromOptions('avatar', {})).toBeUndefined()
  })

  it('chooses a type-specific vault path only for one known type', () => {
    expect(defaultVaultPathFor([gen({ id: 'a', type: 'image' }), gen({ id: 'b', type: 'image' })])).toBe('generated/images')
    expect(defaultVaultPathFor([gen({ id: 'a', type: 'image' }), gen({ id: 'b', type: 'video' })])).toBe('generated/media')
    expect(defaultVaultPathFor([gen({ id: 'a', type: 'unknown' })])).toBe('generated/media')
    expect(defaultVaultPathFor([])).toBe('generated/media')
  })

  it('normalizes safe vault paths and rejects traversal, backslashes, and empty paths', () => {
    expect(normalizeVaultPath(' /generated//images/ ')).toBe('generated/images')
    expect(normalizeVaultPath('generated/../images')).toBeNull()
    expect(normalizeVaultPath('generated/./images')).toBeNull()
    expect(normalizeVaultPath('generated\\images')).toBeNull()
    expect(normalizeVaultPath(' /// ')).toBeNull()
  })

  it('appends pages while preserving the first row for each id', () => {
    const first = gen({ id: 'first', prompt: 'original' })
    const previous = [first]
    const merged = mergeGenerationPages(
      previous,
      [gen({ id: 'first', prompt: 'duplicate' }), gen({ id: 'second' }), gen({ id: 'second', prompt: 'duplicate' })],
    )
    expect(merged.map((row) => row.id)).toEqual(['first', 'second'])
    expect(merged[0]).toBe(first)
    expect(merged[1]?.prompt).toBe('')
    expect(merged).not.toBe(previous)
  })

  it('returns only carried human-readable generation specification segments', () => {
    expect(generationSpecSegments(gen({
      id: 'full',
      metadata: {
        size: '1536x1024',
        resolution: '1080p',
        aspectRatio: '3:2',
        durationSeconds: 61,
        voice: 'alloy',
      },
    }))).toEqual(['1536×1024', '1080p', '3:2', '1:01', 'alloy'])
    expect(generationSpecSegments(gen({ id: 'duration', metadata: { duration: '8s', durationSeconds: 61 } }))).toEqual(['8s'])
    expect(generationSpecSegments(gen({ id: 'empty' }))).toEqual([])
  })
})

describe('normalizeImageCount', () => {
  it('clamps to [1, 8] and floors non-integers / non-numbers', () => {
    expect(normalizeImageCount(0)).toBe(1)
    expect(normalizeImageCount(9)).toBe(8)
    expect(normalizeImageCount(2.7)).toBe(2)
    expect(normalizeImageCount('not-a-number')).toBe(1)
  })
})

describe('model selection', () => {
  const catalog: MediaModelCatalogResponse = {
    defaults: { image: 'img-a', video: 'vid-a', avatar: 'av-a', speech: 'sp-a', transcription: 'tr-a' },
    models: {
      image: [
        { id: 'img-a', name: 'A', type: 'image', status: 'available' },
        { id: 'img-b', name: 'B', type: 'image', status: 'limited' },
      ],
      video: [{ id: 'vid-x', name: 'X', type: 'video', status: 'unavailable' }],
      avatar: [],
      speech: [{ id: 'sp-a', name: 'S', type: 'speech', status: 'available' }],
      transcription: [{ id: 'tr-a', name: 'T', type: 'transcription', status: 'available' }],
    },
  }

  it('preferredModelId returns the catalog default when routable, else first available', () => {
    expect(preferredModelId('image', catalog)).toBe('img-a')
    // video default vid-a is absent; only model is unavailable → falls through to it
    expect(preferredModelId('video', catalog)).toBe('vid-x')
    expect(preferredModelId('avatar', catalog)).toBeUndefined()
    expect(preferredModelId('image', null)).toBeUndefined()
  })

  it('preferredModelId skips an unavailable catalog default when another model is routable', () => {
    const deadDefault = {
      ...catalog,
      defaults: { ...catalog.defaults, image: 'img-dead' },
      models: {
        ...catalog.models,
        image: [
          { id: 'img-dead', name: 'Dead', type: 'image' as const, status: 'unavailable' as const },
          { id: 'img-live', name: 'Live', type: 'image' as const, status: 'available' as const },
        ],
      },
    }

    expect(preferredModelId('image', deadDefault)).toBe('img-live')
  })

  it('preferredModelId keeps a limited catalog default because it remains routable', () => {
    expect(preferredModelId('image', {
      ...catalog,
      defaults: { ...catalog.defaults, image: 'img-b' },
    })).toBe('img-b')
  })

  it('laneUnavailable identifies empty and wholly unavailable lanes', () => {
    const unavailable = { id: 'dead', name: 'Dead', type: 'video' as const, status: 'unavailable' as const }
    const available = { ...unavailable, id: 'live', status: 'available' as const }
    const limited = { ...unavailable, id: 'limited', status: 'limited' as const }

    expect(laneUnavailable([])).toBe(true)
    expect(laneUnavailable([unavailable, { ...unavailable, id: 'also-dead' }])).toBe(true)
    expect(laneUnavailable([limited])).toBe(false)
    expect(laneUnavailable([unavailable, available])).toBe(false)
    expect(laneUnavailable([unavailable, limited])).toBe(false)
  })

  it('selectedModelsWithDefaults keeps a valid selection and resets missing/unavailable ones', () => {
    const out = selectedModelsWithDefaults({ image: 'img-b', video: undefined }, catalog)
    expect(out.image).toBe('img-b') // limited but routable → kept
    expect(out.video).toBe('vid-x') // none routable → resets to the fallback
  })
})

describe('buildGenerationRequestBody', () => {
  it('assembles image fields and trims the prompt', () => {
    const body = buildGenerationRequestBody(reqFields({ type: 'image' }))
    expect(body.prompt).toBe('hello')
    expect(body).toMatchObject({ type: 'image', size: '1024x1024', quality: 'high', n: 1 })
  })

  it('omits every lane parameter the model does not publish', () => {
    // A model with no published metadata (ltx-video) sends the prompt and its
    // own id, and nothing else — an invented `size` or a defaulted `duration`
    // is a parameter the caller never chose.
    const image = buildGenerationRequestBody(reqFields({ type: 'image', image: { count: 2 } }))
    expect(image).not.toHaveProperty('size')
    expect(image).not.toHaveProperty('quality')
    expect(image.n).toBe(2)

    const video = buildGenerationRequestBody(reqFields({ type: 'video', video: {} }))
    expect(video).not.toHaveProperty('duration')
    expect(Object.keys(video).sort()).toEqual(['clientRequestId', 'model', 'prompt', 'type', 'workspaceId'])
  })

  it('preserves wire-typed video durations and includes only supported optional fields', () => {
    const seedanceDuration = FALLBACK_VIDEO_MODEL_OPTIONS['bytedance/seedance-2.0/text-to-video']?.duration?.values?.[1]
    const seedance = buildGenerationRequestBody(reqFields({
      type: 'video',
      video: { duration: seedanceDuration as string, audio: false, mode: 'pro' },
    }))
    expect(seedance.duration).toBe('4')
    expect(seedance).toMatchObject({ audio: false, mode: 'pro' })
    expect(seedance).not.toHaveProperty('resolution')
    expect(seedance).not.toHaveProperty('aspectRatio')
    expect(seedance).not.toHaveProperty('referenceImageUrl')

    const klingDuration = FALLBACK_VIDEO_MODEL_OPTIONS['kling/kling-v1-6']?.duration?.default
    const kling = buildGenerationRequestBody(reqFields({
      type: 'video',
      video: { duration: klingDuration as number, resolution: '720p', aspectRatio: '16:9' },
    }))
    expect(kling.duration).toBe(5)
    expect(kling).toMatchObject({ resolution: '720p', aspectRatio: '16:9' })
  })

  it('omits removed composer fields and optional speech fields when absent', () => {
    const speech = buildGenerationRequestBody(reqFields({ type: 'speech', speech: {} }))
    expect(speech).not.toHaveProperty('negativePrompt')
    expect(speech).not.toHaveProperty('outputPath')
    expect(speech).not.toHaveProperty('voice')
    expect(speech).not.toHaveProperty('speed')

    const configured = buildGenerationRequestBody(reqFields({ type: 'speech', speech: { voice: 'alloy', speed: 1.25 } }))
    expect(configured).toMatchObject({ voice: 'alloy', speed: 1.25 })
  })

  it('omits invalid transcription temperature instead of serializing null', () => {

    const badTemp = buildGenerationRequestBody(reqFields({ type: 'transcription', transcription: { audioUrl: 'https://x/a.mp3', language: '', responseFormat: 'json', temperature: 'oops' } }))
    expect(badTemp.temperature).toBeUndefined()
  })

})

describe('misc guards', () => {
  it('isGenerationType / isLocalGeneration / vault path / output path', () => {
    expect(isGenerationType('image')).toBe(true)
    expect(isGenerationType('nope')).toBe(false)
    expect(isLocalGeneration(gen({ id: 'local-1' }))).toBe(true)
    expect(isLocalGeneration(gen({ id: 'srv' }))).toBe(false)
    expect(generationVaultPath(gen({ id: 'a', metadata: { vaultPath: ' generated/images/x.png ' } }))).toBe('generated/images/x.png')
    expect(outputPathFor('speech')).toBe('generated/audio')
  })
})
