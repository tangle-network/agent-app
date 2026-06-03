import { describe, it, expect } from 'vitest'
import { resolveTangleModelConfig, DEFAULT_TANGLE_ROUTER_BASE_URL } from '../src/runtime/model'

describe('resolveTangleModelConfig', () => {
  it('defaults to the Tangle Router (openai-compat) with TANGLE_API_KEY + MODEL_NAME', () => {
    const c = resolveTangleModelConfig({ env: { MODEL_NAME: 'deepseek/deepseek-chat', TANGLE_API_KEY: 'sk-tan-x' } })
    expect(c).toEqual({ provider: 'openai-compat', model: 'deepseek/deepseek-chat', apiKey: 'sk-tan-x', baseUrl: DEFAULT_TANGLE_ROUTER_BASE_URL })
  })

  it('strips a trailing slash from a custom router base url', () => {
    const c = resolveTangleModelConfig({ env: { MODEL_NAME: 'm', TANGLE_API_KEY: 'k', TANGLE_ROUTER_BASE_URL: 'https://r.example/v1/' } })
    expect(c.baseUrl).toBe('https://r.example/v1')
  })

  it('treats tangle-router / tcloud provider aliases as the router path', () => {
    for (const p of ['tangle-router', 'tcloud', 'openai-compat']) {
      const c = resolveTangleModelConfig({ env: { MODEL_PROVIDER: p, MODEL_NAME: 'm', TANGLE_API_KEY: 'k' } })
      expect(c.provider).toBe('openai-compat')
    }
  })

  it('supports the anthropic BYOK escape hatch', () => {
    const c = resolveTangleModelConfig({ env: { MODEL_PROVIDER: 'anthropic', MODEL_NAME: 'claude-x', ANTHROPIC_API_KEY: 'ak', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } })
    expect(c).toEqual({ provider: 'anthropic', model: 'claude-x', apiKey: 'ak', baseUrl: 'https://api.anthropic.com' })
  })

  it('fails loud on missing required vars + unknown provider', () => {
    expect(() => resolveTangleModelConfig({ env: {} })).toThrow(/MODEL_NAME is required/)
    expect(() => resolveTangleModelConfig({ env: { MODEL_NAME: 'm' } })).toThrow(/TANGLE_API_KEY is required/)
    expect(() => resolveTangleModelConfig({ env: { MODEL_PROVIDER: 'openai', MODEL_NAME: 'm' } })).toThrow(/Unsupported MODEL_PROVIDER/)
    expect(() => resolveTangleModelConfig({ env: { MODEL_PROVIDER: 'anthropic', MODEL_NAME: 'm' } })).toThrow(/ANTHROPIC_API_KEY is required/)
  })
})
