import { describe, expect, it, vi } from 'vitest'
import type { AgentProfile } from '@tangle-network/agent-interface'
import type { SandboxInstance } from '@tangle-network/sandbox/core'
import { fingerprintAgentProfile } from '../profile/fingerprint'
import {
  driveSandboxTurn,
  streamSandboxPrompt,
  type SandboxRuntimeConfig,
  type StreamSandboxPromptOptions,
} from './index'

function profile(): AgentProfile {
  return {
    name: 'server-selected',
    harness: 'codex',
    model: { default: 'openai/gpt-5', provider: 'openai', maxVisibleOutputTokens: 900 },
    prompt: { systemPrompt: 'Server-owned instructions' },
    permissions: { bash: 'deny' },
    tools: { forbidden: false },
    mcp: { sentinel: { transport: 'http', url: 'https://mcp.invalid/sentinel' } },
    resources: {
      files: [{ path: 'policy.md', resource: { kind: 'inline', name: 'policy.md', content: 'Preserve this policy' } }],
    },
  }
}

function fixture() {
  const compose = vi.fn<SandboxRuntimeConfig['profile']>(() => ({ name: 'shell-fallback' }))
  const shell = {
    provider: { providerName: 'openai-compat', apiKey: 'transport-key', defaultModel: 'anthropic/claude-sonnet-4', routerBaseUrl: 'https://router.invalid' },
    profile: compose,
  } as unknown as SandboxRuntimeConfig
  const streamPrompt = vi.fn().mockImplementation(async function* () { yield { type: 'result' } })
  const driveTurn = vi.fn().mockResolvedValue({ state: 'running' })
  const box = { streamPrompt, driveTurn } as unknown as SandboxInstance
  return { shell, box, compose, streamPrompt, driveTurn }
}

type Lane = 'stream' | 'drive'
async function dispatch(lane: Lane, f: ReturnType<typeof fixture>, options: StreamSandboxPromptOptions) {
  if (lane === 'drive') {
    const result = await driveSandboxTurn(f.shell, f.box, 'hello', { ...options, sessionId: 'stable-session' })
    expect(result.succeeded).toBe(true)
    return f.driveTurn.mock.calls[0]![1].backend
  }
  for await (const event of streamSandboxPrompt(f.shell, f.box, 'hello', options)) void event
  return f.streamPrompt.mock.calls[0]![1].backend
}

describe.each<Lane>(['stream', 'drive'])('%s profile dispatch', (lane) => {
  it('dispatches the supplied profile with its identity and preserves its capability boundaries', async () => {
    const f = fixture()
    const selected = profile()
    const original = structuredClone(selected)
    const observed = vi.fn()
    const backend = await dispatch(lane, f, {
      profile: selected,
      effort: 'high',
      maxOutputTokens: 700,
      maxReasoningTokens: 300,
      maxTotalOutputTokens: 800,
      onProfileResolved: observed,
    })
    expect(f.compose).not.toHaveBeenCalled()
    expect(backend.type).toBe('codex')
    expect(backend.model).toMatchObject({ model: 'openai/gpt-5', provider: 'openai-compat', apiKey: 'transport-key', baseUrl: 'https://router.invalid' })
    expect(backend.profile).toMatchObject({
      ...selected,
      model: { ...selected.model, reasoningEffort: 'high', maxVisibleOutputTokens: 700, maxReasoningTokens: 300, maxTotalOutputTokens: 800 },
    })
    expect(selected).toEqual(original)
    expect(observed).toHaveBeenCalledExactlyOnceWith(await fingerprintAgentProfile(backend.profile, { model: backend.model.model, harness: backend.type }))
  })

  it('retains supplied inline resources when shell files are deferred', async () => {
    const f = fixture()
    f.shell.deferProfileFiles = true
    const selected = profile()
    const backend = await dispatch(lane, f, { profile: selected })
    expect(f.compose).not.toHaveBeenCalled()
    expect(backend.profile.resources.files).toEqual(selected.resources?.files)
  })

  it('stamps explicit turn model and harness overrides into the executed profile', async () => {
    const f = fixture()
    const selected = profile()
    const backend = await dispatch(lane, f, { profile: selected, harness: 'opencode', model: 'anthropic/claude-sonnet-4', modelApiKey: 'turn-key' })
    expect(backend.type).toBe('opencode')
    expect(backend.model).toMatchObject({ model: 'anthropic/claude-sonnet-4', apiKey: 'turn-key' })
    expect(backend.profile.harness).toBe('opencode')
    expect(backend.profile.model.default).toBe('anthropic/claude-sonnet-4')
    expect(selected.harness).toBe('codex')
    expect(selected.model?.default).toBe('openai/gpt-5')
  })

  it('honors a model returned by the existing composition callback', async () => {
    const f = fixture()
    f.compose.mockReturnValue(profile())
    const backend = await dispatch(lane, f, {})
    expect(f.compose).toHaveBeenCalled()
    expect(backend.type).toBe('codex')
    expect(backend.model.model).toBe('openai/gpt-5')
  })

  it('recomposes legacy harness-specific resources after discovering the profile harness', async () => {
    const f = fixture()
    f.compose.mockImplementation(({ harness }) => ({
      ...profile(),
      resources: {
        files: [{ path: `${harness}/policy.md`, resource: { kind: 'inline', name: 'policy.md', content: 'policy' } }],
      },
    }))
    const backend = await dispatch(lane, f, {})
    expect(f.compose.mock.calls.map(([options]) => options.harness)).toEqual(['opencode', 'codex'])
    expect(backend.type).toBe('codex')
    expect(backend.profile.resources.files[0].path).toBe('codex/policy.md')
  })

  it('uses profile provider metadata when transport has no configured provider', async () => {
    const f = fixture()
    f.shell.provider = { apiKey: 'profile-provider-key' }
    const backend = await dispatch(lane, f, { profile: profile() })
    expect(backend.model).toMatchObject({ provider: 'openai', model: 'openai/gpt-5', apiKey: 'profile-provider-key' })
  })

  it('treats blank model overrides and configured providers as absent', async () => {
    const f = fixture()
    f.shell.provider = { providerName: '   ', apiKey: 'profile-provider-key' }
    const backend = await dispatch(lane, f, { profile: profile(), model: '   ' })
    expect(backend.model).toMatchObject({ provider: 'openai', model: 'openai/gpt-5', apiKey: 'profile-provider-key' })
    expect(backend.profile.model.default).toBe('openai/gpt-5')
  })

  it('uses the profile provider to validate a bare native model without replacing router transport', async () => {
    const f = fixture()
    const selected = profile()
    selected.model = { default: 'gpt-5', provider: 'openai' }
    const backend = await dispatch(lane, f, { profile: selected })
    expect(backend.type).toBe('codex')
    expect(backend.model).toMatchObject({ model: 'gpt-5', provider: 'openai-compat', apiKey: 'transport-key' })
  })

  it.each([true, false])('does not reuse a stale profile provider for an explicit override (configured transport=%s)', async (configuredTransport) => {
    const f = fixture()
    if (!configuredTransport) f.shell.provider = { apiKey: 'transport-key' }
    await expect(dispatch(lane, f, { profile: profile(), model: 'gemini-3-pro' })).rejects.toThrow(/cannot run model/)
    expect(f.streamPrompt).not.toHaveBeenCalled()
    expect(f.driveTurn).not.toHaveBeenCalled()
  })

  it('uses shell defaults only when the selected profile has no model', async () => {
    const f = fixture()
    const backend = await dispatch(lane, f, { profile: { name: 'no-model', harness: 'opencode' } })
    expect(backend.model.model).toBe('anthropic/claude-sonnet-4')
    expect(backend.profile.model.default).toBe(backend.model.model)
  })

  it.each(['invalid-harness', 'incompatible-model', 'missing-credentials'] as const)('rejects %s before SDK dispatch', async (failure) => {
    const f = fixture()
    const selected = profile()
    if (failure === 'invalid-harness') Object.assign(selected, { harness: 'unknown-runner' })
    if (failure === 'incompatible-model') selected.model = { default: 'anthropic/claude-sonnet-4', provider: 'anthropic' }
    if (failure === 'missing-credentials') f.shell.provider = undefined
    await expect(dispatch(lane, f, { profile: selected })).rejects.toThrow()
    expect(f.streamPrompt).not.toHaveBeenCalled()
    expect(f.driveTurn).not.toHaveBeenCalled()
  })

  it('enforces the prompt budget against the supplied profile before dispatch', async () => {
    const f = fixture()
    f.shell.promptBudget = { maxSystemPromptBytes: 5, overBudgetReason: 'test-boundary' }
    await expect(dispatch(lane, f, { profile: profile() })).rejects.toThrow()
    expect(f.streamPrompt).not.toHaveBeenCalled()
    expect(f.driveTurn).not.toHaveBeenCalled()
  })
})
