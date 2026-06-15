import { describe, it, expect } from 'vitest'
import {
  createChatModelResolution,
  cleanModelId,
  isWellFormedModelId,
  catalogIdsForModel,
  type ChatModelDefaults,
  type LoadModels,
  type ModelInfo,
} from './index'

const DEFAULTS: ChatModelDefaults = {
  routerModel: 'gemini-2.5-flash-lite',
  sandboxOpenaiModel: 'openai/gpt-4o-mini',
  routerBaseUrl: 'https://router.example.test',
  extraAllowlist: ['anthropic/claude-sonnet', 'openai/gpt-5', '', undefined as unknown as string],
}

function loaderOf(catalog: ModelInfo[]): LoadModels {
  return async () => catalog
}

const throwingLoader: LoadModels = async () => {
  throw new Error('router down')
}

describe('resolveChatModel precedence', () => {
  const { resolveChatModel } = createChatModelResolution(DEFAULTS)

  it('request id wins over everything', () => {
    const r = resolveChatModel({
      requestedModel: '  openai/gpt-5  ',
      backend: 'router',
      env: { MODEL_NAME: 'ignored' },
    })
    expect(r).toEqual({ backend: 'router', model: 'openai/gpt-5', source: 'request' })
  })

  it('router backend: env MODEL_NAME over default', () => {
    expect(resolveChatModel({ backend: 'router', env: { MODEL_NAME: 'gpt-x' } })).toEqual({
      backend: 'router',
      model: 'gpt-x',
      source: 'env:MODEL_NAME',
    })
  })

  it('router backend: default when env empty', () => {
    expect(resolveChatModel({ backend: 'router', env: {} })).toEqual({
      backend: 'router',
      model: 'gemini-2.5-flash-lite',
      source: 'default',
    })
  })

  it('sandbox backend: env MODEL_NAME wins', () => {
    expect(resolveChatModel({ backend: 'sandbox', env: { MODEL_NAME: 'local-model' } })).toEqual({
      backend: 'sandbox',
      model: 'local-model',
      source: 'env:MODEL_NAME',
    })
  })

  it('sandbox backend: openai-compat provider -> sandbox openai default', () => {
    expect(resolveChatModel({ backend: 'sandbox', env: { TANGLE_API_KEY: 'k' } })).toEqual({
      backend: 'sandbox',
      model: 'openai/gpt-4o-mini',
      source: 'default',
    })
    expect(resolveChatModel({ backend: 'sandbox', env: { OPENAI_API_KEY: 'k' } })).toEqual({
      backend: 'sandbox',
      model: 'openai/gpt-4o-mini',
      source: 'default',
    })
    expect(resolveChatModel({ backend: 'sandbox', env: { MODEL_PROVIDER: 'openai' } })).toEqual({
      backend: 'sandbox',
      model: 'openai/gpt-4o-mini',
      source: 'default',
    })
  })

  it('sandbox backend: no provider signal -> sandbox-default with no model', () => {
    expect(resolveChatModel({ backend: 'sandbox', env: {} })).toEqual({
      backend: 'sandbox',
      source: 'sandbox-default',
    })
  })
})

describe('validateChatModelId fail-closed flow', () => {
  const { validateChatModelId } = createChatModelResolution(DEFAULTS)

  it('rejects non-string / empty input without hitting the catalog', async () => {
    const r = await validateChatModelId('   ', { loadModels: throwingLoader })
    expect(r).toEqual({ succeeded: false, error: 'Model id must be a non-empty string.' })
  })

  it('rejects a malformed id before the catalog round-trip', async () => {
    const r = await validateChatModelId('bad id!', { loadModels: throwingLoader })
    expect(r).toEqual({ succeeded: false, error: 'Model id is malformed: bad id!' })
  })

  it('short-circuits the constructed allowlist (no catalog call)', async () => {
    let called = false
    const r = await validateChatModelId('openai/gpt-5', {
      loadModels: async () => {
        called = true
        return []
      },
    })
    expect(r).toEqual({ succeeded: true, value: 'openai/gpt-5' })
    expect(called).toBe(false)
  })

  it('seeds the allowlist from the two DEFAULT_* ids and extras', async () => {
    for (const id of ['gemini-2.5-flash-lite', 'openai/gpt-4o-mini', 'anthropic/claude-sonnet']) {
      expect(await validateChatModelId(id, { loadModels: throwingLoader })).toEqual({
        succeeded: true,
        value: id,
      })
    }
  })

  it('accepts an exact catalog id (canonical or bare)', async () => {
    const loadModels = loaderOf([
      { id: 'cohere/command-r' },
      { id: 'standalone-id' },
    ])
    expect(await validateChatModelId('cohere/command-r', { loadModels })).toEqual({
      succeeded: true,
      value: 'cohere/command-r',
    })
    expect(await validateChatModelId('standalone-id', { loadModels })).toEqual({
      succeeded: true,
      value: 'standalone-id',
    })
  })

  it('resolves a bare request id to a provider-prefixed catalog id when the suffix is unique', async () => {
    // No extra allowlist, so the bare id must resolve through the catalog path.
    const { validateChatModelId: validate } = createChatModelResolution({
      routerModel: 'gemini-2.5-flash-lite',
      sandboxOpenaiModel: 'openai/gpt-4o-mini',
      routerBaseUrl: 'https://router.example.test',
    })
    const loadModels = loaderOf([
      { id: 'openai/gpt-5' },
      { id: 'mistral/mistral-large' },
    ])
    const r = await validate('gpt-5', { loadModels })
    expect(r).toEqual({ succeeded: true, value: 'openai/gpt-5' })
  })

  it('rejects a bare request id whose suffix is ambiguous across providers', async () => {
    const loadModels = loaderOf([
      { id: 'openai/x-model' },
      { id: 'vertex/x-model' },
    ])
    const r = await validateChatModelId('x-model', { loadModels })
    expect(r).toEqual({ succeeded: false, error: 'Model is not available: x-model' })
  })

  it('a bare catalog id serves itself exactly (provider-prefixed alias does not shadow the bare match)', async () => {
    const loadModels = loaderOf([{ id: 'mistral-large', _provider: 'mistral' }])
    expect(await validateChatModelId('mistral-large', { loadModels })).toEqual({
      succeeded: true,
      value: 'mistral-large',
    })
    expect(await validateChatModelId('mistral/mistral-large', { loadModels })).toEqual({
      succeeded: true,
      value: 'mistral/mistral-large',
    })
  })

  it('fails closed (no default model) when the catalog loader throws', async () => {
    const r = await validateChatModelId('some/unknown-model', { loadModels: throwingLoader })
    expect(r).toEqual({
      succeeded: false,
      error: 'Could not validate model catalog: router down',
    })
  })

  it('rejects an id absent from both allowlist and catalog', async () => {
    const r = await validateChatModelId('ghost/model', { loadModels: loaderOf([{ id: 'real/model' }]) })
    expect(r).toEqual({ succeeded: false, error: 'Model is not available: ghost/model' })
  })

  it('per-call routerBaseUrl is passed to the loader', async () => {
    let seen: string | undefined
    await validateChatModelId('real/model', {
      routerBaseUrl: 'https://override.test',
      loadModels: async (url) => {
        seen = url
        return [{ id: 'real/model' }]
      },
    })
    expect(seen).toBe('https://override.test')
  })
})

describe('catalog-id helpers', () => {
  it('cleanModelId trims and rejects non-strings', () => {
    expect(cleanModelId('  x  ')).toBe('x')
    expect(cleanModelId('   ')).toBeUndefined()
    expect(cleanModelId(42)).toBeUndefined()
    expect(cleanModelId(undefined)).toBeUndefined()
  })

  it('isWellFormedModelId enforces charset and length', () => {
    expect(isWellFormedModelId('openai/gpt-4o-mini')).toBe(true)
    expect(isWellFormedModelId('a:b@c.d')).toBe(true)
    expect(isWellFormedModelId('has space')).toBe(false)
    expect(isWellFormedModelId('x'.repeat(201))).toBe(false)
  })

  it('catalogIdsForModel adds the provider-prefixed canonical for a bare id but never the bare suffix of a prefixed id', () => {
    expect(new Set(catalogIdsForModel({ id: 'gpt-5', _provider: 'openai' }))).toEqual(
      new Set(['gpt-5', 'openai/gpt-5']),
    )
    expect(catalogIdsForModel({ id: 'openai/gpt-5' })).toEqual(['openai/gpt-5'])
    expect(catalogIdsForModel({ id: '  ' })).toEqual([])
  })
})
