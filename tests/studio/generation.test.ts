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
  buildGenerationRequestBody,
  failedOptimisticGeneration,
  generationError,
  generationMergeKey,
  generationStatus,
  generationVaultPath,
  isGenerationType,
  isLocalGeneration,
  latestBatchOf,
  mergeLiveGeneration,
  mergeLoaderAndLive,
  normalizeImageCount,
  optimisticGeneration,
  outputPathFor,
  preferredModelId,
  selectedModelsWithDefaults,
  userSafeGenerationMessage,
} from '../../src/studio/generation'

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
    negativePrompt: '',
    outputPath: '',
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

  it('marks an optimistic row failed', () => {
    const g = failedOptimisticGeneration(optimisticGeneration({ type: 'image', prompt: 'p', clientRequestId: 'r1' }))
    expect(generationStatus(g)).toBe('failed')
    expect(generationError(g)).toBe('Generation failed')
  })
})

describe('normalizeImageCount', () => {
  it('clamps to [1, 4] and floors non-integers / non-numbers', () => {
    expect(normalizeImageCount(0)).toBe(1)
    expect(normalizeImageCount(9)).toBe(4)
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

  it('coerces numeric video/transcription fields and omits NaN instead of serializing null', () => {
    const ok = buildGenerationRequestBody(reqFields({ type: 'video', video: { duration: '6', resolution: '720p', aspectRatio: '', referenceImageUrl: '' } }))
    expect(ok.duration).toBe(6)
    const bad = buildGenerationRequestBody(reqFields({ type: 'video', video: { duration: 'abc', resolution: '720p', aspectRatio: '', referenceImageUrl: '' } }))
    expect(bad.duration).toBeUndefined()
    expect(JSON.parse(JSON.stringify(bad))).not.toHaveProperty('duration')

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
