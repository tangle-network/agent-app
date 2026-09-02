import { describe, expect, it, vi } from 'vitest'
import type { SandboxInstance } from '@tangle-network/sandbox'
import {
  admitSandboxSessionTurn,
  type AdmitSandboxSessionTurnOptions,
  type SandboxSessionTurnAdmission,
  type SandboxSessionTurnBackend,
  type SandboxSessionTurnMessage,
} from './session-turn'

function options(
  box: Pick<SandboxInstance, 'createSession'>,
  over: Partial<AdmitSandboxSessionTurnOptions> = {},
): AdmitSandboxSessionTurnOptions {
  return {
    box,
    sessionId: 'session-1',
    turnId: 'turn-1',
    backend: { type: 'opencode', profile: { name: 'test' } } as SandboxSessionTurnBackend,
    message: { parts: [{ type: 'text', text: 'hello' }] } as SandboxSessionTurnMessage,
    ...over,
  }
}

function receipt(userMessageId = 'user-1'): SandboxSessionTurnAdmission['receipt'] {
  return {
    info: { id: 'assistant-1', role: 'assistant', timestamp: '2026-09-02T00:00:00.000Z' },
    parts: [],
    userMessageId,
    processing: true,
  }
}

describe('admitSandboxSessionTurn', () => {
  it('creates or reuses the requested session before sending its stable turn', async () => {
    const sendMessage = vi.fn().mockResolvedValue(receipt())
    const createSession = vi.fn().mockResolvedValue({
      session: { id: 'session-1', sendMessage },
      info: { id: 'session-1' },
    })
    const box = { createSession } as unknown as Pick<SandboxInstance, 'createSession'>
    const input = options(box, {
      title: 'Product launch',
      message: {
        parts: [{ type: 'text', text: 'hello' }],
        system: 'Work as the product lead.',
        reasoningEffort: 'high',
        interactions: { question: true },
      } as SandboxSessionTurnMessage,
      sendOptions: { timeoutMs: 30_000 },
    })

    await expect(admitSandboxSessionTurn(input)).resolves.toMatchObject({
      sessionId: 'session-1',
      turnId: 'turn-1',
      receipt: receipt(),
    })
    expect(createSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      title: 'Product launch',
      backend: input.backend,
    })
    expect(sendMessage).toHaveBeenCalledWith(
      {
        parts: input.message.parts,
        turnId: 'turn-1',
        system: input.message.system,
        reasoningEffort: input.message.reasoningEffort,
        interactions: input.message.interactions,
      },
      { timeoutMs: 30_000 },
    )
  })

  it('relies on the Sandbox turn contract for retry idempotency across callers', async () => {
    const receipts = new Map<string, SandboxSessionTurnAdmission['receipt']>()
    let admittedExecutions = 0
    const sendMessage = vi.fn(async (request: { turnId?: string }) => {
      const turnId = request.turnId!
      const prior = receipts.get(turnId)
      if (prior) return prior
      admittedExecutions += 1
      const next = receipt(`user-${admittedExecutions}`)
      receipts.set(turnId, next)
      return next
    })
    const createSession = vi.fn(async () => ({
      session: { id: 'session-1', sendMessage },
      info: { id: 'session-1' },
    }))
    const box = { createSession } as unknown as Pick<SandboxInstance, 'createSession'>

    // ADC owns this atomic check. The fake models its fixed sendMessage(turnId)
    // contract, rather than hiding a process-local duplicate-prevention cache.
    await Promise.all([
      admitSandboxSessionTurn(options(box)),
      admitSandboxSessionTurn(options(box)),
    ])

    expect(createSession).toHaveBeenCalledTimes(2)
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(admittedExecutions).toBe(1)
  })

  it('rejects an empty identity or message before contacting the Sandbox', async () => {
    const createSession = vi.fn()
    const box = { createSession } as unknown as Pick<SandboxInstance, 'createSession'>

    await expect(admitSandboxSessionTurn(options(box, { sessionId: '  ' }))).rejects.toThrow(
      /non-empty sessionId/,
    )
    await expect(admitSandboxSessionTurn(options(box, { turnId: '  ' }))).rejects.toThrow(
      /non-empty turnId/,
    )
    await expect(
      admitSandboxSessionTurn(options(box, { message: { parts: [] } as SandboxSessionTurnMessage })),
    ).rejects.toThrow(/at least one message part/)
    expect(createSession).not.toHaveBeenCalled()
  })

  it('fails closed when the platform returns another session identity', async () => {
    const sendMessage = vi.fn()
    const createSession = vi.fn().mockResolvedValue({
      session: { id: 'session-other', sendMessage },
      info: { id: 'session-other' },
    })
    const box = { createSession } as unknown as Pick<SandboxInstance, 'createSession'>

    await expect(admitSandboxSessionTurn(options(box))).rejects.toThrow(
      'different session for session-1',
    )
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
