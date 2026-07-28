import { describe, expect, it, vi } from 'vitest'
import type { AgentProfile } from '@tangle-network/agent-interface'
import type { SandboxInstance } from '@tangle-network/sandbox'
import { fingerprintAgentProfile, type ProfileFingerprint } from '../profile/fingerprint'
import { streamSandboxPrompt, type SandboxRuntimeConfig } from './index'

/**
 * The observation seam must report the profile the SDK RECEIVED — after the
 * system-prompt override, the MCP merge, and reasoning-effort attachment — not
 * the profile the shell started from. A fingerprint of the shell's base
 * profile passing this test would be the exact bug the seam exists to catch.
 */

const BASE_PROFILE: AgentProfile = {
  name: 'p',
  prompt: { systemPrompt: 'base prompt' },
  mcp: { delegate: { transport: 'http', url: 'https://mcp.invalid/d' } },
  subagents: { researcher: { description: 'r' } },
  resources: { files: [{ path: 'doctrine/a.md', resource: { kind: 'inline', name: 'a.md', content: 'a' } }] },
}

function shell(): SandboxRuntimeConfig {
  return {
    credentials: () => ({ apiKey: 'k', baseUrl: 'https://s' }),
    name: (id: string) => `box-${id}`,
    metadata: (harness: string) => ({ harness }),
    connectedIntegrationIds: async () => [],
    env: async () => ({}),
    files: async () => [],
    secrets: async () => [],
    permissionRole: () => 'developer',
    provider: {
      apiKey: 'router-key',
      providerName: 'openai-compat',
      defaultModel: 'gpt-5-mini',
      routerBaseUrl: 'https://router',
    },
    profile: ({ systemPrompt }: { systemPrompt?: string } = {}) => ({
      ...BASE_PROFILE,
      prompt: { systemPrompt: systemPrompt ?? BASE_PROFILE.prompt!.systemPrompt },
    }),
  } as unknown as SandboxRuntimeConfig
}

function fakeBox(streamPrompt: ReturnType<typeof vi.fn>): SandboxInstance {
  return { streamPrompt } as unknown as SandboxInstance
}

describe('streamSandboxPrompt onProfileResolved', () => {
  it('emits the fingerprint of the EXACT profile handed to box.streamPrompt', async () => {
    async function* events() {
      yield { type: 'result' }
    }
    const streamPrompt = vi.fn().mockReturnValue(events())
    const box = fakeBox(streamPrompt)

    let observed: ProfileFingerprint | undefined
    for await (const _ of streamSandboxPrompt(shell(), box, 'hi', {
      harness: 'opencode',
      systemPrompt: 'PER-TURN PROMPT',
      effort: 'high',
      onProfileResolved: (fp) => {
        observed = fp
      },
    })) {
      void _
    }

    expect(observed).toBeDefined()
    const [, opts] = streamPrompt.mock.calls[0]!
    const handed = await fingerprintAgentProfile(opts.backend.profile, {
      model: opts.backend.model?.model,
      harness: opts.backend.type,
    })
    expect(observed).toEqual(handed)
    // The per-turn override, not the shell's base prompt, is what got fingerprinted.
    expect(observed!.promptBytes).toBe(Buffer.byteLength('PER-TURN PROMPT', 'utf8'))
    expect(observed!.model).toBe('gpt-5-mini')
    expect(observed!.harness).toBe('opencode')
    expect(observed!.mcpKeys).toEqual(['delegate'])
  })

  it('stays silent when the option is not passed', async () => {
    async function* events() {
      yield { type: 'result' }
    }
    const streamPrompt = vi.fn().mockReturnValue(events())
    const out: unknown[] = []
    for await (const e of streamSandboxPrompt(shell(), fakeBox(streamPrompt), 'hi', { harness: 'opencode' })) {
      out.push(e)
    }
    expect(out).toHaveLength(1)
  })
})
