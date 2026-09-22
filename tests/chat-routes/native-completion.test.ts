import { describe, expect, it, vi } from 'vitest'
import {
  aggregateNativeCompletionReceipts,
  observeNativeCompletion,
  type NativeCompletionAdmission,
  type NativeCompletionAdmissionStore,
  type NativeCompletionSessionSource,
  type NativeCompletionTurnReceipt,
} from '../../src/chat-routes/index'

const usageKeys = [
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'costUsd',
] as const

const completeUsage: NativeCompletionTurnReceipt['usage'] = {
  inputTokens: 10,
  outputTokens: 20,
  reasoningTokens: 30,
  cacheReadTokens: 40,
  cacheWriteTokens: 50,
  costUsd: 0.6,
}

function completedTurn(
  turnId: string,
  usage: NativeCompletionTurnReceipt['usage'],
): NativeCompletionTurnReceipt {
  return { turnId, state: 'completed', text: '', parts: [], usage }
}

const admission = {
  executionId: 'turn-1',
  state: 'closed' as const,
  admittedTurnIds: ['turn-1'],
  ownerLeaseUntil: 0,
  closedAt: 1,
}

function store(value: NativeCompletionAdmission = admission): NativeCompletionAdmissionStore {
  return {
    read: vi.fn(async () => value),
    renew: vi.fn(async () => value),
    closeExpired: vi.fn(async () => value),
  }
}

function source(input: {
  status: Record<string, unknown>
  runs?: unknown[]
  messages?: unknown[]
  completed?: unknown
  result?: unknown
}): NativeCompletionSessionSource {
  return {
    findCompletedTurn: vi.fn(async () => input.completed ?? null),
    session: vi.fn(() => ({
      status: vi.fn(async () => input.status),
      runs: vi.fn(async () => input.runs ?? [{
        executionId: 'turn-1', sessionId: 'session-1', status: 'failed', startedAt: 1, completedAt: 2, eventCount: 3, lastEventId: '3',
      }]),
      messages: vi.fn(async () => input.messages ?? []),
      result: vi.fn(async () => input.result ?? { success: false, status: 'error', error: 'failed' }),
    })),
  } as unknown as NativeCompletionSessionSource
}

describe('observeNativeCompletion', () => {
  it.each(usageKeys)('keeps %s unknown when an admitted completed execution omits it', (missingKey) => {
    const partialUsage = { ...completeUsage }
    delete partialUsage[missingKey]

    const aggregated = aggregateNativeCompletionReceipts([
      completedTurn('turn-1', completeUsage),
      completedTurn('turn-2', partialUsage),
    ])

    expect(aggregated.usage).not.toHaveProperty(missingKey)
    for (const key of usageKeys) {
      if (key === missingKey) continue
      expect(aggregated.usage[key]).toBe((completeUsage[key] ?? 0) * 2)
    }
  })

  it.each(usageKeys)('preserves a measured zero for %s', (zeroKey) => {
    const firstUsage = { ...completeUsage, [zeroKey]: 0 }
    const secondUsage = { ...completeUsage, [zeroKey]: 0 }

    const aggregated = aggregateNativeCompletionReceipts([
      completedTurn('turn-1', firstUsage),
      completedTurn('turn-2', secondUsage),
    ])

    expect(aggregated.usage[zeroKey]).toBe(0)
  })

  it('uses the admission returned by renewal before deciding the turn is still running', async () => {
    const admissionStore = store({
      ...admission,
      state: 'open' as const,
      ownerLeaseUntil: 10_000,
    })
    admissionStore.renew = vi.fn(async () => ({
      ...admission,
      state: 'closed' as const,
      closedAt: 1,
    }))

    const observed = await observeNativeCompletion({
      source: source({ status: { id: 'session-1', status: 'running', latestExecutionId: 'turn-1' } }),
      admissionStore,
      executionId: 'turn-1', sessionId: 'session-1', turnId: 'turn-1', registeredAt: 0, now: 700_000,
    })

    expect(admissionStore.renew).toHaveBeenCalledWith('turn-1', new Date(700_000))
    expect(observed).toMatchObject({
      state: 'failed',
      receipt: { error: 'Admitted native execution did not produce an exact completion: turn-1' },
    })
  })

  it('returns a completed receipt from the exact cached turn and assistant message', async () => {
    const observed = await observeNativeCompletion({
      source: source({
        status: { id: 'session-1', status: 'completed', latestExecutionId: 'turn-1' },
        runs: [{ executionId: 'turn-1', sessionId: 'session-1', status: 'completed', startedAt: 1, completedAt: 2, eventCount: 3, lastEventId: '3' }],
        completed: {
          turnId: 'turn-1', sessionId: 'session-1',
          result: {
            response: 'completed answer',
            usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5 },
            costUsd: 0.04,
            servedModel: 'served-model', servedProvider: 'served-provider', servedSource: 'profile',
          },
        },
        messages: [{
          id: 'assistant-1', role: 'assistant', timestamp: '2026-09-20T00:00:00.000Z',
          metadata: { turnId: 'turn-1', status: 'completed', completed: true },
          parts: [{ type: 'text', text: 'completed answer' }],
        }],
      }),
      admissionStore: store(),
      executionId: 'turn-1', sessionId: 'session-1', turnId: 'turn-1', registeredAt: 0, now: 100,
    })

    expect(observed).toMatchObject({
      state: 'completed',
      receipt: {
        state: 'completed', text: 'completed answer',
        usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5, costUsd: 0.04 },
        servedModel: 'served-model', servedProvider: 'served-provider', servedSource: 'profile',
        completedTurnIds: ['turn-1'],
      },
    })
    if (observed.state === 'running') throw new Error('expected completed receipt')
    expect(observed.receipt.parts).toEqual([
      expect.objectContaining({ type: 'text', text: 'completed answer' }),
    ])
  })

  it('retains partial tool and file parts from an exact interrupted turn without billing it', async () => {
    const box = source({
      status: { id: 'session-1', status: 'cancelled', latestExecutionId: 'turn-1', failureReason: { message: 'cancelled' } },
      messages: [{
        id: 'assistant-1', role: 'assistant', timestamp: '2026-09-20T00:00:00.000Z',
        metadata: { turnId: 'turn-1', status: 'interrupted', interrupted: true, interruptReason: 'user cancelled' },
        parts: [
          { type: 'tool', id: 'tool-1', tool: 'write', state: { status: 'completed', input: { path: 'draft.md' }, output: { ok: true } } },
          { type: 'file', id: 'file-1', path: 'draft.md', filename: 'draft.md' },
          { type: 'step-finish', id: 'usage-1', tokens: { input: 10, output: 2, reasoning: 4, cache: { read: 6, write: 8 } }, cost: 0.03 },
        ],
      }],
      result: { success: false, status: 'cancelled', error: 'user cancelled', usage: { inputTokens: 10, outputTokens: 2 }, costUsd: 0.03 },
    })

    const observed = await observeNativeCompletion({
      source: box,
      admissionStore: store(),
      executionId: 'turn-1', sessionId: 'session-1', turnId: 'turn-1', registeredAt: 0, now: 100,
    })

    expect(observed).toMatchObject({
      state: 'failed',
      receipt: {
        state: 'failed', error: 'user cancelled', completedTurnIds: ['turn-1'],
        usage: { inputTokens: 10, outputTokens: 2, reasoningTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 8, costUsd: 0.03 },
      },
    })
    if (observed.state === 'running') throw new Error('expected terminal receipt')
    expect(observed.receipt.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool', id: 'tool-1' }),
      expect.objectContaining({ type: 'file', path: 'draft.md' }),
    ]))
  })

  it('treats a missing terminal receipt as retryable until its deadline', async () => {
    const observed = await observeNativeCompletion({
      source: source({ status: { id: 'session-1', status: 'completed', latestExecutionId: 'turn-1' } }),
      admissionStore: store(),
      executionId: 'turn-1', sessionId: 'session-1', turnId: 'turn-1', registeredAt: 0, now: 100,
    })
    expect(observed).toEqual({ state: 'running' })
  })

  it('uses registration time when a closed admission has no close timestamps', async () => {
    const observed = await observeNativeCompletion({
      source: source({ status: { id: 'session-1', status: 'completed', latestExecutionId: 'turn-1' } }),
      admissionStore: store({
        ...admission,
        closedAt: undefined,
        updatedAt: undefined,
      }),
      executionId: 'turn-1', sessionId: 'session-1', turnId: 'turn-1',
      registeredAt: 100, now: 102, receiptDeadlineMs: 1,
    })

    expect(observed).toMatchObject({
      state: 'failed',
      receipt: { error: 'Admitted native execution did not produce an exact completion: turn-1' },
    })
  })

  it('recognizes a structurally reported Sandbox not-found without a runtime import', async () => {
    const session = {
      status: vi.fn(async () => { throw { name: 'NotFoundError', code: 'NOT_FOUND', status: 404 } }),
      runs: vi.fn(async () => []),
      messages: vi.fn(async () => []),
      result: vi.fn(async () => null),
    }
    const observed = await observeNativeCompletion({
      source: {
        findCompletedTurn: vi.fn(async () => null),
        session: vi.fn(() => session),
      } as unknown as NativeCompletionSessionSource,
      admissionStore: store({ ...admission, state: 'open', ownerLeaseUntil: 10_000 }),
      executionId: 'turn-1', sessionId: 'session-1', turnId: 'turn-1', registeredAt: 0, now: 100,
    })

    expect(observed).toEqual({ state: 'running' })
  })

  it('does not let a different latest execution prove this admitted turn completed', async () => {
    const observed = await observeNativeCompletion({
      source: source({ status: { id: 'session-1', status: 'completed', latestExecutionId: 'other-turn' } }),
      admissionStore: store(),
      executionId: 'turn-1', sessionId: 'session-1', turnId: 'turn-1', registeredAt: 0, now: 700_000,
    })
    expect(observed).toMatchObject({
      state: 'failed',
      receipt: { error: 'Admitted native execution did not produce an exact completion: turn-1' },
    })
  })

  it('preserves an earlier interrupted receipt when a later admitted continuation completes', async () => {
    const box = source({
      status: { id: 'session-1', status: 'completed', latestExecutionId: 'turn-2' },
      runs: [
        { executionId: 'turn-2', sessionId: 'session-1', status: 'completed', startedAt: 2, completedAt: 3, eventCount: 3, lastEventId: '3' },
        { executionId: 'turn-1', sessionId: 'session-1', status: 'failed', startedAt: 1, completedAt: 2, eventCount: 2, lastEventId: '2' },
      ],
      completed: {
        turnId: 'turn-2', sessionId: 'session-1',
        result: { response: 'continuation completed' },
      },
      messages: [{
        id: 'assistant-1', role: 'assistant', timestamp: '2026-09-20T00:00:00.000Z',
        metadata: { turnId: 'turn-1', status: 'interrupted', interrupted: true, interruptReason: 'base failed' },
        parts: [{ type: 'tool', id: 'tool-1', tool: 'write', state: { status: 'completed' } }],
      }],
      result: { success: false, status: 'error', error: 'base failed', usage: { inputTokens: 10 } },
    })

    const observed = await observeNativeCompletion({
      source: box,
      admissionStore: store({ ...admission, admittedTurnIds: ['turn-1', 'turn-2'] }),
      executionId: 'turn-1', sessionId: 'session-1', turnId: 'turn-1', registeredAt: 0, now: 100,
    })

    expect(observed).toMatchObject({
      state: 'failed',
      receipt: {
        error: 'base failed', text: 'continuation completed', completedTurnIds: ['turn-1', 'turn-2'],
      },
    })
    if (observed.state === 'running') throw new Error('expected terminal receipt')
    expect(observed.receipt.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool', id: 'tool-1' }),
    ]))
  })

  it('retains exact earlier partial parts when a later terminal receipt stays missing past its deadline', async () => {
    const box = source({
      status: { id: 'session-1', status: 'completed', latestExecutionId: 'turn-2' },
      runs: [
        { executionId: 'turn-2', sessionId: 'session-1', status: 'completed', startedAt: 2, completedAt: 3, eventCount: 3, lastEventId: '3' },
        { executionId: 'turn-1', sessionId: 'session-1', status: 'failed', startedAt: 1, completedAt: 2, eventCount: 2, lastEventId: '2' },
      ],
      messages: [{
        id: 'assistant-1', role: 'assistant', timestamp: '2026-09-20T00:00:00.000Z',
        metadata: { turnId: 'turn-1', status: 'interrupted', interrupted: true, interruptReason: 'base failed' },
        parts: [{ type: 'file', id: 'file-1', path: 'partial.md', filename: 'partial.md' }],
      }],
      result: { success: false, status: 'error', error: 'base failed', usage: { inputTokens: 10 } },
    })

    const observed = await observeNativeCompletion({
      source: box,
      admissionStore: store({ ...admission, admittedTurnIds: ['turn-1', 'turn-2'] }),
      executionId: 'turn-1', sessionId: 'session-1', turnId: 'turn-1', registeredAt: 0, now: 700_000,
    })

    expect(observed).toMatchObject({
      state: 'failed',
      receipt: {
        error: 'Admitted native execution did not produce an exact completion: turn-2',
        usage: {}, completedTurnIds: ['turn-1', 'turn-2'],
      },
    })
    if (observed.state === 'running') throw new Error('expected terminal receipt')
    expect(observed.receipt.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'file', path: 'partial.md' }),
    ]))
  })
})
