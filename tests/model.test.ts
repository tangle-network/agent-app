import { describe, it, expect } from 'vitest'
import {
  createTangleRouterModelConfig,
  DEFAULT_TANGLE_ROUTER_BASE_URL,
  isTangleBillingEnforcementDisabled,
  isTangleExecutionKeyError,
  resolveTangleModelConfig,
  resolveTangleExecutionEnvironment,
  resolveUserTangleExecutionKey,
  resolveUserTangleExecutionKeyForUser,
  tangleExecutionKeyHttpError,
} from '../src/runtime/model'

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

describe('resolveUserTangleExecutionKey', () => {
  it('resolves app environment from common env names', () => {
    expect(resolveTangleExecutionEnvironment({ APP_ENV: 'local' })).toBe('development')
    expect(resolveTangleExecutionEnvironment({ NODE_ENV: 'development' })).toBe('development')
    expect(resolveTangleExecutionEnvironment({ APP_ENV: 'staging' })).toBe('staging')
    expect(resolveTangleExecutionEnvironment({ NODE_ENV: 'test' })).toBe('test')
    expect(resolveTangleExecutionEnvironment({ APP_ENV: 'preview' })).toBe('production')
    expect(resolveTangleExecutionEnvironment({})).toBe('production')
  })

  it('uses TANGLE_API_KEY in local development', async () => {
    await expect(resolveUserTangleExecutionKey({
      environment: 'development',
      env: { TANGLE_API_KEY: ' sk-local ' },
      getUserApiKey: async () => 'sk-user',
    })).resolves.toEqual({ apiKey: 'sk-local', source: 'local-env' })
  })

  it('can infer local development from env without app-side environment policy', async () => {
    await expect(resolveUserTangleExecutionKey({
      env: { APP_ENV: 'local', TANGLE_API_KEY: 'sk-local' },
      getUserApiKey: async () => 'sk-user',
    })).resolves.toEqual({ apiKey: 'sk-local', source: 'local-env' })
  })

  it('falls back to the app-provided user key when local development has no env key', async () => {
    await expect(resolveUserTangleExecutionKey({
      environment: 'development',
      env: {},
      getUserApiKey: async () => ' sk-user ',
    })).resolves.toEqual({ apiKey: 'sk-user', source: 'user' })
  })

  it('fails loud when local development has no env key or user key', async () => {
    await expect(resolveUserTangleExecutionKey({
      environment: 'development',
      env: {},
      getUserApiKey: async () => null,
    })).rejects.toMatchObject({
      code: 'local_tangle_api_key_required',
      status: 503,
    })
  })

  it('uses the app-provided user key in deployed environments', async () => {
    await expect(resolveUserTangleExecutionKey({
      env: { TANGLE_API_KEY: 'sk-env-ignored' },
      getUserApiKey: async () => ' sk-user ',
    })).resolves.toEqual({ apiKey: 'sk-user', source: 'user' })
  })

  it('uses the app-provided user key in test environments', async () => {
    await expect(resolveUserTangleExecutionKey({
      environment: 'test',
      env: { TANGLE_API_KEY: 'sk-env-ignored' },
      getUserApiKey: async () => ' sk-user ',
    })).resolves.toEqual({ apiKey: 'sk-user', source: 'user' })
  })

  it('passes the user id to the app storage seam', async () => {
    await expect(resolveUserTangleExecutionKeyForUser({
      userId: 'u1',
      env: { APP_ENV: 'production', TANGLE_API_KEY: 'sk-env-ignored' },
      getUserApiKey: async (userId) => userId === 'u1' ? 'sk-user' : null,
    })).resolves.toEqual({ apiKey: 'sk-user', source: 'user' })
  })

  it('throws a typed connect-account error when deployed users have no key', async () => {
    try {
      await resolveUserTangleExecutionKey({
        environment: 'staging',
        env: { TANGLE_API_KEY: 'sk-env-ignored' },
        getUserApiKey: async () => null,
      })
      expect.fail('expected resolver to throw')
    } catch (error) {
      expect(isTangleExecutionKeyError(error)).toBe(true)
      expect(error).toMatchObject({
        code: 'tangle_account_not_connected',
        status: 401,
      })
      expect(tangleExecutionKeyHttpError(error)).toEqual({
        status: 401,
        body: {
          error: 'Connect your Tangle account before invoking this agent.',
          code: 'tangle_account_not_connected',
        },
      })
    }
  })

  it('recognizes serialized execution-key errors from another realm', () => {
    const error = {
      name: 'TangleExecutionKeyError',
      message: 'Connect your Tangle account before invoking this agent.',
      code: 'tangle_account_not_connected',
      status: 401,
    }

    expect(isTangleExecutionKeyError(error)).toBe(true)
    expect(tangleExecutionKeyHttpError(error)).toEqual({
      status: 401,
      body: {
        error: 'Connect your Tangle account before invoking this agent.',
        code: 'tangle_account_not_connected',
      },
    })
  })

  it('does not recognize structural execution-key errors without a message', () => {
    expect(isTangleExecutionKeyError({
      name: 'TangleExecutionKeyError',
      code: 'tangle_account_not_connected',
      status: 401,
    })).toBe(false)
  })
})

describe('isTangleBillingEnforcementDisabled', () => {
  it('defaults billing enforcement off in local development', () => {
    expect(isTangleBillingEnforcementDisabled({ env: { APP_ENV: 'development' } })).toBe(true)
    expect(isTangleBillingEnforcementDisabled({ env: { NODE_ENV: 'local' } })).toBe(true)
  })

  it('defaults billing enforcement on outside local development', () => {
    expect(isTangleBillingEnforcementDisabled({ env: { APP_ENV: 'production' } })).toBe(false)
    expect(isTangleBillingEnforcementDisabled({ env: { APP_ENV: 'staging' } })).toBe(false)
    expect(isTangleBillingEnforcementDisabled({ env: { APP_ENV: 'test' } })).toBe(false)
    expect(isTangleBillingEnforcementDisabled({ env: {} })).toBe(false)
  })

  it('supports the shared enforcement override flag', () => {
    expect(isTangleBillingEnforcementDisabled({
      env: {
        APP_ENV: 'production',
        TANGLE_BILLING_ENFORCEMENT: 'disabled',
      },
    })).toBe(true)

    expect(isTangleBillingEnforcementDisabled({
      env: {
        APP_ENV: 'development',
        TANGLE_BILLING_ENFORCEMENT: 'enabled',
      },
    })).toBe(false)
  })

  it('supports app-specific enforcement override flags', () => {
    expect(isTangleBillingEnforcementDisabled({
      enforcementEnvVar: 'GTM_BILLING_ENFORCEMENT',
      env: {
        APP_ENV: 'production',
        GTM_BILLING_ENFORCEMENT: 'disabled',
      },
    })).toBe(true)

    expect(isTangleBillingEnforcementDisabled({
      enforcementEnvVar: 'GTM_BILLING_ENFORCEMENT',
      env: {
        APP_ENV: 'development',
        GTM_BILLING_ENFORCEMENT: 'enabled',
      },
    })).toBe(false)
  })
})

describe('createTangleRouterModelConfig', () => {
  it('builds router config from an explicit execution key', () => {
    expect(createTangleRouterModelConfig({
      apiKey: ' sk-user ',
      model: ' openai/gpt-5.4 ',
      baseUrl: 'https://router.example/v1/',
    })).toEqual({
      provider: 'openai-compat',
      model: 'openai/gpt-5.4',
      apiKey: 'sk-user',
      baseUrl: 'https://router.example/v1',
    })
  })

  it('does not silently fall back when key or model is missing', () => {
    expect(() => createTangleRouterModelConfig({ apiKey: ' ', model: 'm' })).toThrow(/apiKey/)
    expect(() => createTangleRouterModelConfig({ apiKey: 'sk', model: ' ' })).toThrow(/model/)
  })
})
