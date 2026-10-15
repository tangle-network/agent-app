import { describe, expect, it, vi } from 'vitest'
import type { SandboxInstance } from '@tangle-network/sandbox'
import {
  backendModelFields, resolveModelSelection, streamSandboxPrompt,
  type ProviderResolutionConfig, type SandboxRuntimeConfig,
} from './index'

const native = {
  providerName: 'openai', defaultModel: 'gpt-6.1-sol', authMode: 'oauth',
  cliAuth: { account: 'codex-seat', secretEnv: 'CODEX_AUTH_BUNDLE', format: 'bundle' },
} satisfies ProviderResolutionConfig

describe('native OAuth model transport', () => {
  it('resolves an explicit subscription reference without enabling router-keyless auth', () => {
    const selected = resolveModelSelection(native)
    expect(selected.succeeded).toBe(true)
    if (!selected.succeeded || !selected.value) throw new Error('Native model was not resolved')
    expect(backendModelFields(selected.value)).toEqual({ model: {
      provider: 'openai', model: native.defaultModel, authMode: 'oauth', cliAuth: native.cliAuth,
    } })
  })

  it('forwards native auth and preparation pins through the shared stream without wrapping the box', async () => {
    const streamPrompt = vi.fn(async function* () { yield { type: 'done' } })
    const box = { streamPrompt } as unknown as SandboxInstance
    const shell = { provider: native } as unknown as SandboxRuntimeConfig
    const pins = {
      expectedPublicProfileRequestDigest: `sha256:${'a'.repeat(64)}` as const,
      expectedSecretProfileReceipt: `hmac-sha256:${'b'.repeat(64)}` as const,
    }
    for await (const event of streamSandboxPrompt(shell, box, 'hello', {
      profile: { name: 'native', harness: 'codex', model: { provider: 'openai', default: native.defaultModel } },
      sessionId: 'native-session', ...pins,
    })) void event
    expect(streamPrompt).toHaveBeenCalledWith('hello', expect.objectContaining({
      ...pins, backend: expect.objectContaining({ type: 'codex', model: {
        provider: 'openai', model: native.defaultModel, authMode: 'oauth', cliAuth: native.cliAuth,
      } }),
    }))
  })

  it.each([
    { cliAuth: undefined },
    { cliAuth: { ...native.cliAuth, account: '' } },
    { cliAuth: { ...native.cliAuth, secretEnv: '   ' } },
    { cliAuth: { ...native.cliAuth, format: 'unsupported' } },
    { cliAuth: { ...native.cliAuth, token: 'controlled-readable-canary' } },
    { providerName: 'openai-compat' },
    { apiKey: 'controlled-paid-canary' },
    { openaiApiKey: 'controlled-paid-canary' },
    { routerBaseUrl: 'https://router.example.com/v1' },
    { authMode: undefined },
    { defaultModel: undefined },
  ])('refuses malformed or ambiguous native auth %#', change => {
    // Exercise the runtime boundary too: deserialized values may violate TS.
    expect(() => resolveModelSelection({ ...native, ...change } as ProviderResolutionConfig)).toThrow()
  })

  it('refuses a paid per-turn override instead of silently selecting it for OAuth', () => {
    expect(() => resolveModelSelection(native, { modelApiKey: 'controlled-paid-canary' })).toThrow()
  })
})
