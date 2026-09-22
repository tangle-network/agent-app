import { describe, expect, it, vi } from 'vitest'
import {
  runNativeCompletionWorkflow,
  type NativeCompletionWorkflowPayload,
} from './native-completion-workflow'
import type { CloudflareWorkflowStepLike } from './detached-turn-workflow'

function workflowStep(): { step: CloudflareWorkflowStepLike; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    step: {
      do: async <T>(name: string, callback: (context: unknown) => Promise<T>) => {
        calls.push(name)
        return callback(undefined)
      },
      sleep: async (name: string) => { calls.push(name) },
    },
  }
}

function replayingWorkflowStep(): {
  step: CloudflareWorkflowStepLike
  calls: string[]
  executed: string[]
} {
  const calls: string[] = []
  const executed: string[] = []
  const cache = new Map<string, unknown>()
  return {
    calls,
    executed,
    step: {
      do: async <T>(name: string, callback: (context: unknown) => Promise<T>) => {
        calls.push(name)
        if (cache.has(name)) return cache.get(name) as T
        executed.push(name)
        const value = await callback(undefined)
        cache.set(name, value)
        return value
      },
      sleep: async (name: string) => { calls.push(name) },
    },
  }
}

const payload: NativeCompletionWorkflowPayload = {
  sessionId: 'session-1', turnId: 'turn-1', registeredAt: 1,
}

describe('runNativeCompletionWorkflow', () => {
  it('prepares outside Workflow steps and settles before it finalizes or releases', async () => {
    const { step, calls } = workflowStep()
    const order: string[] = []
    const receipt = { state: 'completed' as const, text: '', parts: [{ type: 'file', path: 'artifact.md' }], usage: {}, completedTurnIds: ['turn-1'] }

    const prepare = vi.fn(async (_payload, inputReceipt) => {
      order.push('prepare')
      return { ...inputReceipt, text: 'prepared' }
    })

    await expect(runNativeCompletionWorkflow({
      event: { payload }, step,
      observe: vi.fn(async () => ({ state: 'completed' as const, receipt })),
      prepare,
      persistTranscript: vi.fn(async () => { order.push('persist'); return 'assistant:turn-1' }),
      settle: vi.fn(async () => { order.push('settle') }),
      finalizeBuffer: vi.fn(async () => { order.push('finalize') }),
      releaseLock: vi.fn(async () => { order.push('release') }),
    })).resolves.toMatchObject({
      state: 'completed', text: 'prepared', parts: [{ type: 'file', path: 'artifact.md' }], usage: {}, completedTurnIds: ['turn-1'],
    })

    expect(prepare).toHaveBeenCalledWith(payload, receipt)
    expect(order).toEqual(['prepare', 'persist', 'settle', 'finalize', 'release'])
    expect(calls).toEqual([
      'native-completion:observe:drive:0',
      'native-completion:observe:settle',
      'native-completion:persist-transcript',
      'native-completion:finalize-buffer',
      'native-completion:release-lock',
    ])
  })

  it('keeps the lock held when product settlement fails', async () => {
    const { step, calls } = workflowStep()
    const releaseLock = vi.fn(async () => {})
    const error = new Error('Vault unavailable')

    await expect(runNativeCompletionWorkflow({
      event: { payload }, step,
      observe: async () => ({ state: 'failed' as const, receipt: { state: 'failed', text: '', parts: [{ type: 'tool' }], usage: {}, error: 'native failed', completedTurnIds: ['turn-1'] } }),
      persistTranscript: async () => 'assistant:turn-1',
      settle: async () => { throw error },
      releaseLock,
    })).rejects.toBe(error)

    expect(releaseLock).not.toHaveBeenCalled()
    expect(calls).not.toContain('native-completion:release-lock')
  })

  it('updates the original transcript when Vault settlement revises the receipt to failed', async () => {
    const { step, calls } = workflowStep()
    const order: string[] = []
    const initialReceipt = { state: 'completed' as const, text: 'draft', parts: [{ type: 'file', path: 'draft.md' }], usage: {}, completedTurnIds: ['turn-1'] }
    const settledReceipt = { ...initialReceipt, state: 'failed' as const, error: 'Vault unavailable' }
    const transcriptRows = new Map<string, typeof initialReceipt | typeof settledReceipt>()
    const persistTranscript = vi.fn(async (
      _payload,
      nextReceipt,
      existingMessageId?: string,
    ) => {
      const messageId = existingMessageId ?? 'assistant:turn-1'
      transcriptRows.set(messageId, nextReceipt)
      order.push(`persist:${nextReceipt.state}:${messageId}`)
      return messageId
    })
    const finalizeBuffer = vi.fn(async (_payload, nextReceipt, messageId) => {
      order.push(`finalize:${nextReceipt.state}:${messageId}`)
    })

    await expect(runNativeCompletionWorkflow({
      event: { payload }, step,
      observe: async () => ({ state: 'completed' as const, receipt: initialReceipt }),
      persistTranscript,
      settle: async () => { order.push('settle'); return settledReceipt },
      finalizeBuffer,
      releaseLock: async () => { order.push('release') },
    })).resolves.toEqual(settledReceipt)

    expect(persistTranscript).toHaveBeenNthCalledWith(1, payload, initialReceipt)
    expect(persistTranscript).toHaveBeenNthCalledWith(2, payload, settledReceipt, 'assistant:turn-1')
    expect(transcriptRows).toEqual(new Map([['assistant:turn-1', settledReceipt]]))
    expect(transcriptRows.size).toBe(1)
    expect(finalizeBuffer).toHaveBeenCalledWith(payload, settledReceipt, 'assistant:turn-1')
    expect(order).toEqual([
      'persist:completed:assistant:turn-1',
      'settle',
      'persist:failed:assistant:turn-1',
      'finalize:failed:assistant:turn-1',
      'release',
    ])
    expect(calls).toEqual([
      'native-completion:observe:drive:0',
      'native-completion:observe:settle',
      'native-completion:persist-transcript',
      'native-completion:persist-final-transcript',
      'native-completion:finalize-buffer',
      'native-completion:release-lock',
    ])
  })

  it('replays cached observation and transcript steps after settlement failure', async () => {
    const { step, calls, executed } = replayingWorkflowStep()
    const initialReceipt = { state: 'completed' as const, text: 'draft', parts: [{ type: 'file', path: 'draft.md' }], usage: {}, completedTurnIds: ['turn-1'] }
    const settledReceipt = { ...initialReceipt, state: 'failed' as const, error: 'Vault unavailable' }
    const order: string[] = []
    let settlementAttempts = 0
    const persistTranscript = vi.fn(async (_payload, nextReceipt, existingMessageId?: string) => {
      const messageId = existingMessageId ?? 'assistant:turn-1'
      order.push(`persist:${nextReceipt.state}:${messageId}`)
      return messageId
    })
    const settle = vi.fn(async () => {
      settlementAttempts += 1
      order.push(`settle:${settlementAttempts}`)
      if (settlementAttempts === 1) throw new Error('Vault unavailable')
      return settledReceipt
    })
    const finalizeBuffer = vi.fn(async (_payload, nextReceipt, messageId) => {
      order.push(`finalize:${nextReceipt.state}:${messageId}`)
    })
    const releaseLock = vi.fn(async () => { order.push('release') })
    const options = {
      event: { payload }, step,
      observe: vi.fn(async () => ({ state: 'completed' as const, receipt: initialReceipt })),
      persistTranscript,
      settle,
      finalizeBuffer,
      releaseLock,
    }

    await expect(runNativeCompletionWorkflow(options)).rejects.toThrow('Vault unavailable')
    expect(releaseLock).not.toHaveBeenCalled()
    expect(finalizeBuffer).not.toHaveBeenCalled()

    await expect(runNativeCompletionWorkflow(options)).resolves.toEqual(settledReceipt)

    expect(options.observe).toHaveBeenCalledTimes(1)
    expect(persistTranscript).toHaveBeenCalledTimes(2)
    expect(persistTranscript).toHaveBeenNthCalledWith(1, payload, initialReceipt)
    expect(persistTranscript).toHaveBeenNthCalledWith(2, payload, settledReceipt, 'assistant:turn-1')
    expect(settle).toHaveBeenCalledTimes(2)
    expect(finalizeBuffer).toHaveBeenCalledTimes(1)
    expect(finalizeBuffer).toHaveBeenCalledWith(payload, settledReceipt, 'assistant:turn-1')
    expect(releaseLock).toHaveBeenCalledTimes(1)
    expect(order).toEqual([
      'persist:completed:assistant:turn-1',
      'settle:1',
      'settle:2',
      'persist:failed:assistant:turn-1',
      'finalize:failed:assistant:turn-1',
      'release',
    ])
    expect(executed).toEqual([
      'native-completion:observe:drive:0',
      'native-completion:observe:settle',
      'native-completion:persist-transcript',
      'native-completion:persist-final-transcript',
      'native-completion:finalize-buffer',
      'native-completion:release-lock',
    ])
    expect(calls).toEqual([
      'native-completion:observe:drive:0',
      'native-completion:observe:settle',
      'native-completion:persist-transcript',
      'native-completion:observe:drive:0',
      'native-completion:observe:settle',
      'native-completion:persist-transcript',
      'native-completion:persist-final-transcript',
      'native-completion:finalize-buffer',
      'native-completion:release-lock',
    ])
  })
})
