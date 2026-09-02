import { beforeEach, describe, expect, it, vi } from 'vitest'

const sandboxMocks = vi.hoisted(() => ({
  createClaimStore: vi.fn(),
  ensureWorkspace: vi.fn(),
  peekWorkspace: vi.fn(),
}))

vi.mock('@tangle-network/agent-app/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tangle-network/agent-app/sandbox')>()
  return {
    ...actual,
    createD1PrewarmClaimStore: sandboxMocks.createClaimStore,
    ensureWorkspaceSandbox: sandboxMocks.ensureWorkspace,
    peekWorkspaceSandbox: sandboxMocks.peekWorkspace,
  }
})

import { createSandboxProduce } from '../src/sandbox'
import type { AppEnv } from '../src/env'

describe('sandbox foreground provisioning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs createSandboxProduce through the shared fenced claim', async () => {
    const lease = { key: 'workspace-1::opencode', expiresAt: 123 }
    const claim = {
      acquire: vi.fn(async () => true),
      release: vi.fn(async () => undefined),
      isHeld: vi.fn(async () => false),
      inspect: vi.fn(async () => ({ status: 'absent' as const })),
      acquireLease: vi.fn(async () => lease),
      releaseLease: vi.fn(async () => undefined),
    }
    const box = { id: 'box-1' }
    const db = {} as D1Database
    const env: AppEnv = {
      DB: db,
      BETTER_AUTH_URL: 'http://localhost:8787',
      BETTER_AUTH_SECRET: 'test-secret',
      SANDBOX_API_KEY: 'sandbox-key',
      SANDBOX_GATEWAY_URL: 'https://sandbox.example.test',
    }
    sandboxMocks.createClaimStore.mockReturnValue(claim)
    sandboxMocks.ensureWorkspace.mockResolvedValue(box)

    const producer = await createSandboxProduce(env)({
      request: new Request('http://localhost:8787/api/chat', { method: 'POST' }),
      body: { threadId: 'thread-1', content: 'Hello' },
      identity: {
        tenantId: 'workspace-1',
        sessionId: 'thread-1',
        userId: 'user-1',
        turnIndex: 0,
      },
      context: undefined,
      prompt: 'Hello',
      executionId: 'execution-1',
      turnStreamId: 'turn-1',
      priorMessages: [],
      userMessageId: 'message-1',
    })

    expect(producer.stream).toBeDefined()
    expect(sandboxMocks.createClaimStore).toHaveBeenCalledWith(db)
    expect(claim.acquireLease).toHaveBeenCalledWith('workspace-1::opencode', 180)
    expect(sandboxMocks.ensureWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.any(Function) }),
      { workspaceId: 'workspace-1', userId: 'user-1', harness: 'opencode' },
    )
    expect(claim.releaseLease).toHaveBeenCalledWith(lease)
    expect(sandboxMocks.peekWorkspace).not.toHaveBeenCalled()
  })
})
