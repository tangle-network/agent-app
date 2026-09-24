import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile } from '@tangle-network/sandbox'
import { createHostedAgent, HostedAnswerRejected, type HostedAgentStore, type HostedInbound } from './index'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  runTurn: vi.fn(),
}))

vi.mock('@tangle-network/hub-sdk', () => ({
  HubClient: class {
    tools = { invoke: mocks.invoke }
  },
  authenticateHubEventRequest: vi.fn(),
}))
vi.mock('@tangle-network/sandbox/core', () => ({
  Sandbox: class {},
  SandboxError: class extends Error {},
}))
vi.mock('@tangle-network/agent-integrations/conversation-events', () => ({
  normalizeConversationEvent: () => ({
    ok: true,
    event: { sender: { id: '+15555550123' }, text: 'Status of Sandbox?', isGroup: false, historyOnly: false, occurredAt: null },
  }),
  buildMessagingReply: (_event: unknown, text: string) => ({
    ok: true,
    reply: { action: 'inkbox.imessage.reply', input: { text }, idempotencyKey: 'reply-test' },
  }),
}))
vi.mock('./engine', () => ({
  TurnPending: class extends Error {},
  runHostedTurn: mocks.runTurn,
}))

const inbound = { runId: 'run-1', connectionId: 'connection-1', event: {} } as HostedInbound

function makeStore() {
  const values = new Map<string, string>()
  const store: HostedAgentStore = {
    get: async key => values.get(key) ?? null,
    put: async (key, value) => { values.set(key, value) },
  }
  return { store, values }
}

describe('hosted answer validation', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.runTurn.mockReset()
    mocks.runTurn.mockImplementation(async (_turn, ports) => {
      const answer = 'Sandbox is ready, without a source citation.'
      await ports.answered(answer, { id: 'box-1' })
      return { ok: true, text: answer }
    })
  })

  it.each([false, true])('does not send or remember a rejected answer on lastAttempt=%s', async lastAttempt => {
    const { store, values } = makeStore()
    const validateAnswer = vi.fn(async () => { throw new HostedAnswerRejected() })
    const agent = createHostedAgent({
      apiKey: 'test-key', profile: { name: 'test' } as AgentProfile, store, validateAnswer,
    })

    expect(await agent.respond(inbound, { lastAttempt })).toBe('ignored')
    expect(validateAnswer).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({ text: 'Status of Sandbox?', channel: 'imessage' }),
      answer: 'Sandbox is ready, without a source citation.',
    }))
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect([...values.keys()].filter(key => key.startsWith('convo:'))).toEqual([])
  })

  it('stores and sends only the canonical validated text', async () => {
    const { store, values } = makeStore()
    const canonical = 'Sandbox is ready. [Vault: sandbox-sdk.md:42]'
    const validateAnswer = vi.fn(async () => canonical)
    const agent = createHostedAgent({
      apiKey: 'test-key', profile: { name: 'test' } as AgentProfile, store, validateAnswer,
    })

    expect(await agent.respond(inbound)).toBe('replied')
    expect(validateAnswer).toHaveBeenCalledTimes(1)
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    expect(mocks.invoke.mock.calls[0]?.[1]).toEqual({ text: canonical })
    expect([...values.entries()].find(([key]) => key.startsWith('convo:'))?.[1]).toContain(canonical)
  })

  it('withholds a validated answer that would lose its citation at the Hub limit', async () => {
    const { store, values } = makeStore()
    const canonical = `${'x'.repeat(1500)}[Vault: sandbox-sdk.md:42]`
    const agent = createHostedAgent({
      apiKey: 'test-key', profile: { name: 'test' } as AgentProfile, store,
      validateAnswer: async () => canonical,
    })

    expect(await agent.respond(inbound, { lastAttempt: true })).toBe('ignored')
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect([...values.keys()].filter(key => key.startsWith('convo:'))).toEqual([])
  })

  it('withholds a validated answer the Hub would reject before storing it', async () => {
    const { store, values } = makeStore()
    const agent = createHostedAgent({
      apiKey: 'test-key', profile: { name: 'test' } as AgentProfile, store,
      validateAnswer: async () => 'Sandbox is ready.\0[Vault: sandbox-sdk.md:42]',
    })

    expect(await agent.respond(inbound)).toBe('ignored')
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect([...values.keys()].filter(key => key.startsWith('convo:'))).toEqual([])
  })

  it('sends only the checked answer even when the owner has debug enabled', async () => {
    const { store } = makeStore()
    const address = '+15555550123'
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address))
    const user = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)
    await store.put(`debug:${user}`, '1')
    const canonical = 'Sandbox is ready. [Vault: sandbox-sdk.md:42]'
    const agent = createHostedAgent({
      apiKey: 'test-key', profile: { name: 'test' } as AgentProfile, store, owner: address,
      validateAnswer: async () => canonical,
    })

    expect(await agent.respond(inbound)).toBe('replied')
    expect(mocks.invoke.mock.calls[0]?.[1]).toEqual({ text: canonical })
  })

  it('retries an unavailable validator even on the last queue attempt without sending', async () => {
    const { store, values } = makeStore()
    const agent = createHostedAgent({
      apiKey: 'test-key', profile: { name: 'test' } as AgentProfile, store,
      validateAnswer: async () => { throw new Error('source read failed') },
    })

    await expect(agent.respond(inbound, { lastAttempt: true })).rejects.toMatchObject({ code: 'answer_validation_unavailable' })
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect([...values.keys()].filter(key => key.startsWith('convo:'))).toEqual([])
  })
})
