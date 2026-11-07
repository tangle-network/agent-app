/**
 * The backend agent-app resolves for a turn, through the installed Sandbox SDK's
 * own normalizer: `SandboxInstance.streamPrompt` and `driveTurn` keep only the
 * fields `normalizeRuntimeBackendConfig` returns, so a model or per-turn key
 * spelled any other way never reaches the platform.
 */
import type { AgentProfile } from '@tangle-network/agent-interface'
import { normalizeRuntimeBackendConfig, type TurnBackendConfig } from '@tangle-network/sandbox'
import { describe, expect, it } from 'vitest'
import { fingerprintAgentProfile, type ProfileFingerprint } from '../../src/profile/fingerprint'
import { resolveSandboxPromptBackend } from '../../src/sandbox'

describe('resolved sandbox backend through the SDK normalizer', () => {
  it('keeps the turn model, provider, delegated key and base URL', async () => {
    const profile: AgentProfile = {
      name: 'wire', harness: 'opencode',
      model: { default: 'openai/gpt-5', provider: 'openai' },
      prompt: { systemPrompt: 'Answer briefly.' },
    }
    let observed: ProfileFingerprint | undefined
    const backend = await resolveSandboxPromptBackend(
      { provider: { providerName: 'openai-compat', apiKey: 'shell-key', routerBaseUrl: 'https://router.invalid/v1' } },
      { profile, modelApiKey: 'delegated-turn-key', onProfileResolved: (fingerprint) => { observed = fingerprint } },
    )
    const wire = normalizeRuntimeBackendConfig(backend) as TurnBackendConfig | undefined
    expect(wire?.model).toEqual({
      model: 'openai/gpt-5',
      provider: 'openai-compat',
      apiKey: 'delegated-turn-key',
      baseUrl: 'https://router.invalid/v1',
    })
    expect(wire?.type).toBe('opencode')
    expect(observed).toEqual(await fingerprintAgentProfile(wire!.profile as AgentProfile, {
      model: wire!.model!.model, harness: wire!.type,
    }))
  })
})
