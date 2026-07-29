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
  it('recovers the exact completed message with canonical tool parts, text, and usage', async () => {
    const box = source({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          timestamp: '2026-07-29T00:00:00.000Z',
          metadata: { turnId: 'turn-1' },
          parts: [{ type: 'text', text: 'status?' }],
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          timestamp: '2026-07-29T00:00:01.000Z',
          metadata: {
            turnId: 'turn-1',
            status: 'completed',
            completed: true,
            completedAt: '2026-07-29T00:00:01.000Z',
          },
          parts: [
            {
              type: 'tool',
              id: 'call-1',
              callID: 'call-1',
              sessionID: 'session-1',
              messageID: 'assistant-1',
              tool: 'workspace_status',
              state: {
                status: 'completed',
                input: {},
                output: { relationships: 3 },
              },
            },
            { type: 'step-start', id: 'step-1' },
            {
              type: 'step-finish',
              id: 'finish-1',
              tokens: {
                input: 10,
                output: 2,
                reasoning: 1,
                cache: { read: 3, write: 4 },
              },
              cost: 0.01,
            },
            { type: 'text', id: 'text-1', text: '3 relationships' },
            { type: 'text', id: 'message-part-delta', text: '3 relationships' },
            {
              type: 'step-finish',
              id: 'finish-2',
              tokens: { input: 5, output: 1 },
              cost: 0.02,
            },
          ],
        },
      ],
      result: {
        success: true,
        status: 'success',
        response: '3 relationships',
        usage: { inputTokens: 15, outputTokens: 3 },
        costUsd: 0.03,
      },
    })

    const completed = await readCompletedSandboxTurn(box, {
      turnId: 'turn-1',
      sessionId: 'session-1',
    })

    expect(completed).toMatchObject({
      text: '3 relationships',
      usage: {
        inputTokens: 15,
        outputTokens: 3,
        reasoningTokens: 1,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        costUsd: 0.03,
      },
    })
    expect(completed?.parts?.filter((part) => part.type === 'text')).toEqual([
      expect.objectContaining({ type: 'text', text: '3 relationships' }),
    ])
    expect(completed?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool',
          id: 'call-1',
          tool: 'workspace_status',
          state: expect.objectContaining({ status: 'completed' }),
        }),
      ]),
    )
  })

  it('never reads the latest session result for an older completed turn', async () => {
    const result = vi.fn(async () => ({
      response: 'wrong newer answer',
      usage: { inputTokens: 999, outputTokens: 999 },
    }))
    const box = {
      findCompletedTurn: vi.fn(async () => null),
      session: vi.fn(() => ({
        messages: vi.fn(async () => [
          {
            id: 'assistant-old',
            role: 'assistant',
            timestamp: '2026-07-29T00:00:01.000Z',
            metadata: { turnId: 'turn-old', status: 'completed', completed: true },
            parts: [
              { type: 'text', id: 'old-text', text: 'correct older answer' },
              { type: 'step-finish', tokens: { input: 8, output: 2 }, cost: 0.01 },
            ],
          },
          {
            id: 'user-new',
            role: 'user',
            timestamp: '2026-07-29T00:00:02.000Z',
            metadata: { turnId: 'turn-new' },
            parts: [{ type: 'text', text: 'new question' }],
          },
          {
            id: 'assistant-new',
            role: 'assistant',
            timestamp: '2026-07-29T00:00:03.000Z',
            metadata: { turnId: 'turn-new', status: 'completed', completed: true },
            parts: [{ type: 'text', id: 'new-text', text: 'wrong newer answer' }],
          },
        ]),
        result,
      })),
    } as unknown as CompletedSandboxTurnSource

    const completed = await readCompletedSandboxTurn(box, {
      turnId: 'turn-old',
      sessionId: 'session-1',
    })

    expect(completed).toMatchObject({
      text: 'correct older answer',
      usage: { inputTokens: 8, outputTokens: 2, costUsd: 0.01 },
    })
    expect(result).not.toHaveBeenCalled()
  })

  it('uses an exact completed-turn cache hit when the session message is unavailable', async () => {
    const box = source({
      completed: {
        turnId: 'turn-1',
        sessionId: 'session-1',
        completedAt: '2026-07-29T00:00:01.000Z',
        result: {
          response: 'cached answer',
          tokenUsage: { inputTokens: 21, outputTokens: 4 },
          costUsd: 0.04,
        },
      },
    })

    await expect(readCompletedSandboxTurn(box, {
      turnId: 'turn-1',
      sessionId: 'session-1',
    })).resolves.toEqual({
      text: 'cached answer',
      usage: { inputTokens: 21, outputTokens: 4, costUsd: 0.04 },
    })
  })

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
    })).resolves.toBeNull()
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
    })).resolves.toBeNull()
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
