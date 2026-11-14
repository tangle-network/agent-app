import { describe, expect, it, vi } from 'vitest'
import { type AgentProfile } from '@tangle-network/agent-interface'
import { createSandboxRuntimeClient } from '@tangle-network/sandbox/runtime'
import { composeAgentProfile } from '../src/profile/index'
import { resolveSandboxPromptBackend } from '../src/sandbox/index'

describe('composed file profile through the published Sandbox SDK', () => {
  it('preserves server-authored controls and knowledge files in the public session request', async () => {
    const base: AgentProfile = {
      name: 'server-selected', harness: 'opencode',
      model: { provider: 'openai-compat', default: 'openai/gpt-5' },
      prompt: { systemPrompt: 'Server-owned policy' },
      tools: { forbidden: false }, permissions: { bash: 'deny' },
    }
    const knowledgeFiles = [{
      path: 'facts.md',
      resource: { kind: 'inline' as const, name: 'facts.md', content: 'Server-selected knowledge' },
    }]
    const profile = composeAgentProfile(base, { knowledge: knowledgeFiles })
    const backend = await resolveSandboxPromptBackend({
      provider: { providerName: 'openai-compat', allowKeylessModel: true },
    }, { profile })
    // Real public SDK validation and serialization. Only its HTTP peer is fake;
    // this does not claim deployed execution or Interface 5 knowledge-pin support.
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ id: 'session-contract', status: 'running' }))
    const runtime = createSandboxRuntimeClient({
      baseUrl: 'https://sandbox.invalid', token: 'synthetic-scoped-token', fetch,
    })
    const session = await runtime.createSession({ sessionId: 'session-contract', backend })
    expect(session.id).toBe('session-contract')
    expect(fetch).toHaveBeenCalledOnce()
    const [url, request] = fetch.mock.calls[0]!
    expect(url).toBe('https://sandbox.invalid/agents/sessions')
    expect(request?.method).toBe('POST')
    const sent = JSON.parse(String(request?.body))
    expect(sent.sessionId).toBe('session-contract')
    expect(sent.backend.profile).toMatchObject({
      ...base, resources: { files: knowledgeFiles },
    })
    expect(sent.backend.profile.resources.knowledge).toBeUndefined()
    expect(base).not.toHaveProperty('resources')
  })

  it('carries a keyless OpenCode CLI-owned model as backend.model.mode "cli"', async () => {
    // Disco's director: OpenCode's own free model, no key. Without `mode: "cli"`
    // the platform refuses: "missing backend.model.apiKey".
    const backend = await resolveSandboxPromptBackend({
      provider: { providerName: 'opencode', modelName: 'glm-5.3-flash-free', allowKeylessModel: true, mode: 'cli' },
    }, { profile: { name: 'director', harness: 'opencode', prompt: { systemPrompt: 'Direct.' } } })
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ id: 'session-cli', status: 'running' }))
    const runtime = createSandboxRuntimeClient({
      baseUrl: 'https://sandbox.invalid', token: 'synthetic-scoped-token', fetch,
    })
    await runtime.createSession({ sessionId: 'session-cli', backend })
    const sent = JSON.parse(String(fetch.mock.calls[0]![1]?.body))
    expect(sent.backend.type).toBe('opencode')
    expect(sent.backend.model).toEqual({ model: 'glm-5.3-flash-free', provider: 'opencode', mode: 'cli' })
  })
})
