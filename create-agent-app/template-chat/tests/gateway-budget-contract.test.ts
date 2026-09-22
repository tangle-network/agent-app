import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatTurnProduceArgs } from '@tangle-network/agent-app/chat-routes'

const boundary = vi.hoisted(() => ({
  claim: vi.fn(),
  ensure: vi.fn(),
  stream: vi.fn(),
}))
vi.mock('@tangle-network/agent-app/sandbox', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tangle-network/agent-app/sandbox')>(),
  createD1PrewarmClaimStore: boundary.claim,
  ensureWorkspaceSandbox: boundary.ensure,
  streamSandboxPrompt: boundary.stream,
}))
import { createSandboxProduce } from '../src/sandbox'
import type { AppEnv } from '../src/env'

beforeEach(() => {
  vi.clearAllMocks()
  boundary.claim.mockReturnValue({
    acquire: async () => true,
    release: async () => undefined,
    isHeld: async () => false,
    inspect: async () => ({ status: 'absent' as const }),
    acquireLease: async () => ({ key: 'workspace-1::opencode', expiresAt: Date.now() + 180000 }),
    releaseLease: async () => undefined,
  })
  boundary.ensure.mockResolvedValue({ id: 'box-1' })
  boundary.stream.mockImplementation(async function* () {
    yield { type: 'result', data: { finalText: 'Done.' } }
  })
})

const env = {
  DB: {}, BETTER_AUTH_URL: 'http://localhost:8787', BETTER_AUTH_SECRET: 'test-only-secret',
  SANDBOX_API_KEY: 'not-a-live-key', SANDBOX_GATEWAY_URL: 'https://sandbox.example.test',
} as AppEnv

async function dispatch(limits: ChatTurnProduceArgs<void>['executionLimits']) {
  const producer = await createSandboxProduce(env)({
    request: new Request('http://localhost:8787/api/chat', { method: 'POST' }),
    body: { threadId: 'thread-1', content: 'Hello' },
    identity: { tenantId: 'workspace-1', sessionId: 'thread-1', userId: 'user-1', turnIndex: 0 },
    context: undefined, prompt: 'Hello', executionId: 'execution-1', turnStreamId: 'turn-1',
    priorMessages: [], userMessageId: 'message-1', executionLimits: limits,
  })
  for await (const _event of producer.stream) { /* Drain the actual producer. */ }
  expect(boundary.stream).toHaveBeenCalledTimes(1)
  const call = boundary.stream.mock.calls[0]
  if (!call) throw new Error('The actual producer did not call the native stream boundary')
  return call[3]
}

describe('Gateway inclusive output budget at the native sandbox boundary', () => {
  it.each([undefined, 100, 0])('does not add the reasoning subset (%s) to total output authority', async reasoning => {
    const options = await dispatch({
      maxOutputTokens: 321,
      ...(reasoning !== undefined ? { maxReasoningTokens: reasoning } : {}),
    })
    expect(options.maxOutputTokens).toBe(321)
    expect(options.maxTotalOutputTokens).toBe(321)
    if (reasoning === undefined) expect(options).not.toHaveProperty('maxReasoningTokens')
    else if (reasoning === 0) expect(options.effort).toBe('none')
    else expect(options.maxReasoningTokens).toBe(reasoning)
  })

  it('does not invent token ceilings for an uncapped browser turn', async () => {
    const options = await dispatch(undefined)
    expect(options).not.toHaveProperty('maxOutputTokens')
    expect(options).not.toHaveProperty('maxTotalOutputTokens')
    expect(options).not.toHaveProperty('maxReasoningTokens')
  })
})
