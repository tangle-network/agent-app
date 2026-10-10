import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
  observeNativeCompletion,
  type NativeCompletionAdmissionStore,
  type NativeCompletionObservation,
  type NativeCompletionSessionSource,
} from '../../src/chat-routes/native-completion'

const attribution = {
  servedModel: 'admitted-model',
  servedProvider: 'admitted-provider',
  servedSource: 'profile' as const,
}
const knownUsage = {
  inputTokens: 10, outputTokens: 2, reasoningTokens: 3,
  cacheReadTokens: 4, cacheWriteTokens: 5, costUsd: 0.25,
}

function fixture(options: {
  status?: 'completed' | 'failed' | 'cancelled'
  turns?: string[]
  cache?: (call: number) => unknown
  messagesError?: Error
  result?: Record<string, unknown>
  eventCount?: number
} = {}) {
  const turns = options.turns ?? ['turn-1']
  const status = options.status ?? 'completed'
  const calls = { cache: 0, messages: 0, results: [] as string[] }
  const session = {
    status: async () => ({ id: 'session-1', status }),
    runs: async () => turns.map(executionId => ({
      executionId, sessionId: 'session-1', status, eventCount: options.eventCount ?? 3, lastEventId: String(options.eventCount ?? 3),
    })),
    messages: async () => {
      calls.messages++
      if (options.messagesError) throw options.messagesError
      return turns.map(turnId => ({
        id: `assistant:${turnId}`, role: 'assistant', parts: [],
        metadata: status === 'completed'
          ? { turnId, completed: true }
          : { turnId, interrupted: true, interruptReason: 'interrupted' },
      }))
    },
    result: async ({ executionId }: { executionId: string }) => {
      calls.results.push(executionId)
      return options.result ?? { response: 'partial response', usage: knownUsage, costUsd: 0.25 }
    },
  }
  // Only observation methods exist: attempting to prompt or cancel cannot pass.
  const source = {
    session: (sessionId: string) => {
      assert.equal(sessionId, 'session-1')
      return session
    },
    findCompletedTurn: async (turnId: string, scope: { sessionId: string }) => {
      assert.equal(scope.sessionId, 'session-1')
      calls.cache++
      return options.cache ? options.cache(calls.cache) : {
        turnId, sessionId: 'session-1',
        result: { response: 'retained answer', usage: knownUsage, costUsd: 0.25, ...attribution },
      }
    },
  } as unknown as NativeCompletionSessionSource
  const admission = {
    executionId: 'turn-1', state: 'closed' as const,
    admittedTurnIds: turns, ownerLeaseUntil: 0, closedAt: 1,
  }
  const admissionStore: NativeCompletionAdmissionStore = {
    read: async () => admission,
    renew: async () => { throw new Error('closed admission must not be renewed') },
    closeExpired: async () => { throw new Error('closed admission must not be closed again') },
  }
  return {
    calls,
    observe: () => observeNativeCompletion({
      source, admissionStore, executionId: 'turn-1', sessionId: 'session-1',
      turnId: 'turn-1', registeredAt: 0, now: 100,
    }),
  }
}

function terminal(observed: NativeCompletionObservation) {
  assert.notEqual(observed.state, 'running')
  if (observed.state === 'running') throw new Error('expected terminal receipt')
  return observed.receipt
}

describe('native completion uses one validated terminal receipt', () => {
  it('reads each completed cache and message projection once', async () => {
    const test = fixture()
    const receipt = terminal(await test.observe())
    assert.equal(receipt.text, 'retained answer')
    assert.deepEqual(receipt.usage, knownUsage)
    assert.equal(receipt.servedModel, attribution.servedModel)
    assert.equal(receipt.servedProvider, attribution.servedProvider)
    assert.equal(receipt.servedSource, attribution.servedSource)
    assert.deepEqual(test.calls, { cache: 1, messages: 1, results: [] })
  })

  for (const wrong of [{ turnId: 'foreign-turn' }, { sessionId: 'foreign-session' }]) {
    it(`does not borrow attribution or usage from a mismatched ${Object.keys(wrong)[0]}`, async () => {
      const test = fixture({ cache: () => ({
        turnId: 'turn-1', sessionId: 'session-1', ...wrong,
        result: { response: 'foreign answer', usage: knownUsage, ...attribution },
      }) })
      const receipt = terminal(await test.observe())
      assert.equal(receipt.state, 'completed') // The exact assistant message still exists.
      assert.equal(receipt.text, '')
      assert.deepEqual(receipt.usage, {})
      for (const key of ['servedModel', 'servedProvider', 'servedSource'] as const) {
        assert.equal(receipt[key], undefined)
      }
      assert.equal(test.calls.cache, 1)
    })
  }

  it('does not mix an exact first read with a different second cache record', async () => {
    const test = fixture({ cache: call => ({
      turnId: call === 1 ? 'turn-1' : 'foreign-turn', sessionId: 'session-1',
      result: { response: 'retained answer', servedModel: call === 1 ? 'original' : 'foreign' },
    }) })
    assert.equal(terminal(await test.observe()).servedModel, 'original')
    assert.equal(test.calls.cache, 1)
  })

  it('does not introduce a second failure after a successful exact cache read', async () => {
    const test = fixture({ cache: call => {
      if (call > 1) throw new Error('second read unavailable')
      return { turnId: 'turn-1', sessionId: 'session-1', result: { response: 'retained answer' } }
    } })
    assert.equal(terminal(await test.observe()).text, 'retained answer')
    assert.equal(test.calls.cache, 1)
  })

  it('can recover exact cached content when the message read fails', async () => {
    const test = fixture({ messagesError: new Error('message store unavailable') })
    const receipt = terminal(await test.observe())
    assert.equal(receipt.text, 'retained answer')
    assert.equal(receipt.servedModel, attribution.servedModel)
    assert.deepEqual(test.calls, { cache: 1, messages: 1, results: [] })
  })

  it('can recover an exact message without inventing attribution when the cache read fails', async () => {
    const test = fixture({ cache: () => { throw new Error('cache unavailable') } })
    const receipt = terminal(await test.observe())
    assert.equal(receipt.state, 'completed')
    assert.deepEqual(receipt.usage, {})
    assert.equal(receipt.servedModel, undefined)
  })

  it('still throws when neither exact read can establish a completion', async () => {
    const test = fixture({
      cache: () => { throw new Error('cache unavailable') },
      messagesError: new Error('message store unavailable'),
    })
    await assert.rejects(test.observe(), /could not be verified/)
    assert.deepEqual(test.calls, { cache: 1, messages: 1, results: [] })
  })

  for (const status of ['failed', 'cancelled'] as const) {
    it(`uses the completed-result usage vocabulary for a ${status} execution`, async () => {
      const test = fixture({ status, result: {
        response: 'partial response', error: 'interrupted',
        tokenUsage: {
          promptTokens: '10', completionTokens: '2', reasoning: '3',
          cacheReadInputTokens: '4', cacheCreationInputTokens: '5', cost: '0.25',
        },
        metadata: { effectiveBackend: { model: 'admitted-model', provider: 'admitted-provider', source: 'profile' } },
      } })
      const receipt = terminal(await test.observe())
      assert.equal(receipt.state, 'failed')
      assert.equal(receipt.text, 'partial response')
      assert.deepEqual(receipt.usage, knownUsage)
      assert.equal(receipt.servedModel, attribution.servedModel)
      assert.deepEqual(test.calls, { cache: 0, messages: 1, results: ['turn-1'] })
    })
  }

  it('does not let an invalid raw cost override the validated result decoder', async () => {
    const test = fixture({ status: 'failed', result: { costUsd: Number.NaN } })
    assert.deepEqual(terminal(await test.observe()).usage, {})
  })

  it('preserves measured zero and terminal reasoning usage', async () => {
    const zero = Object.fromEntries(Object.keys(knownUsage).map(key => [key, 0]))
    const test = fixture({ status: 'failed', result: { usage: zero, costUsd: 0 } })
    assert.deepEqual(terminal(await test.observe()).usage, zero)
  })

  it('reads interrupted history only once across multiple failed continuations', async () => {
    const test = fixture({ status: 'failed', turns: ['turn-1', 'turn-2'] })
    const receipt = terminal(await test.observe())
    assert.deepEqual(receipt.completedTurnIds, ['turn-1', 'turn-2'])
    assert.deepEqual(test.calls, { cache: 0, messages: 1, results: ['turn-1', 'turn-2'] })
  })

  it('takes a long interrupted execution\'s receipt from its recorded message without replaying it', async () => {
    const test = fixture({ status: 'failed', eventCount: 40_000 })
    const receipt = terminal(await test.observe())
    assert.equal(receipt.state, 'failed')
    assert.equal(receipt.error, 'interrupted')
    assert.deepEqual(receipt.completedTurnIds, ['turn-1'])
    assert.deepEqual(test.calls, { cache: 0, messages: 1, results: [] })
  })
})
