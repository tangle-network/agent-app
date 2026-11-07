import { describe, expect, it, vi } from 'vitest'

import {
  readCompletedSandboxTurn,
  type CompletedSandboxTurnSource,
} from '../../src/chat-routes/index'

function source(input: {
  completed?: unknown
  messages?: unknown[]
  result?: unknown
}): CompletedSandboxTurnSource {
  return {
    findCompletedTurn: vi.fn(async () => input.completed ?? null),
    session: vi.fn(() => ({
      messages: vi.fn(async () => input.messages ?? []),
      result: vi.fn(async () => input.result ?? {}),
    })),
  } as unknown as CompletedSandboxTurnSource
}

describe('readCompletedSandboxTurn', () => {
  it('fails closed when neither cache nor message belongs to the requested turn', async () => {
    const box = source({
      completed: {
        turnId: 'turn-other',
        sessionId: 'session-1',
        completedAt: '2026-07-29T00:00:01.000Z',
        result: { response: 'wrong answer' },
      },
      messages: [{
        id: 'assistant-other',
        role: 'assistant',
        timestamp: '2026-07-29T00:00:01.000Z',
        metadata: { turnId: 'turn-other', status: 'completed', completed: true },
        parts: [{ type: 'text', text: 'wrong answer' }],
      }],
    })

    await expect(readCompletedSandboxTurn(box, {
      turnId: 'turn-1',
      sessionId: 'session-1',
    })).rejects.toThrow('Completed Sandbox turn identity is inconsistent')
  })

  it('fails closed instead of guessing between duplicate completed messages', async () => {
    const duplicate = {
      id: 'assistant-duplicate',
      role: 'assistant',
      timestamp: '2026-07-29T00:00:01.000Z',
      metadata: { turnId: 'turn-1', status: 'completed', completed: true },
      parts: [{ type: 'text', text: 'ambiguous answer' }],
    }
    const box = source({
      messages: [duplicate, { ...duplicate, id: 'assistant-duplicate-2' }],
      result: { response: 'ambiguous answer' },
    })

    await expect(readCompletedSandboxTurn(box, {
      turnId: 'turn-1',
      sessionId: 'session-1',
    })).rejects.toThrow('Completed Sandbox turn identity is inconsistent')
  })

  it('recovers from the exact session message when the short-lived cache is unavailable', async () => {
    const box = {
      findCompletedTurn: vi.fn(async () => {
        throw new Error('cache unavailable')
      }),
      session: vi.fn(() => ({
        messages: vi.fn(async () => [{
          id: 'assistant-1',
          role: 'assistant',
          timestamp: '2026-07-29T00:00:01.000Z',
          metadata: { turnId: 'turn-1', status: 'completed', completed: true },
          parts: [
            { type: 'text', id: 'text-1', text: 'durable answer' },
            { type: 'step-finish', tokens: { input: 9, output: 2 } },
          ],
        }]),
        result: vi.fn(async () => ({
          response: 'durable answer',
          usage: { inputTokens: 9, outputTokens: 2 },
        })),
      })),
    } as unknown as CompletedSandboxTurnSource

    await expect(readCompletedSandboxTurn(box, {
      turnId: 'turn-1',
      sessionId: 'session-1',
    })).resolves.toMatchObject({
      text: 'durable answer',
      usage: { inputTokens: 9, outputTokens: 2 },
    })
  })
})
