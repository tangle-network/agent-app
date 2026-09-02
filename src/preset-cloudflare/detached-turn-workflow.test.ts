import { describe, expect, it, vi } from 'vitest'
import {
  runDetachedTurnWorkflowTick,
  type CloudflareWorkflowStepLike,
  type DetachedTurnDriveOutcome,
  type DetachedTurnTerminalResult,
} from './detached-turn-workflow'

function step(): {
  value: CloudflareWorkflowStepLike
  doStep: ReturnType<typeof vi.fn>
  sleep: ReturnType<typeof vi.fn>
} {
  const doStep = vi.fn(async <T>(
    _name: string,
    callback: (context: unknown) => Promise<T>,
  ) => callback(undefined))
  const sleep = vi.fn(async (_name: string, _duration: string | number) => {})
  return {
    value: {
      do: doStep as unknown as CloudflareWorkflowStepLike['do'],
      sleep,
    },
    doStep,
    sleep,
  }
}

describe('runDetachedTurnWorkflowTick', () => {
  it('drives one pass at a time, sleeps while running, then settles exact ids', async () => {
    const payload = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      prompt: 'go',
    }
    const states: DetachedTurnDriveOutcome[] = [
      { succeeded: true, value: { state: 'running', elapsedMs: 10 } },
      { succeeded: true, value: { state: 'completed', text: 'done', result: {} } },
    ]
    const drive = vi.fn(async (received: typeof payload) => {
      expect(received).toBe(payload)
      return states.shift()!
    })
    const settled = { persisted: true }
    const settle = vi.fn(async (received: typeof payload, result: DetachedTurnTerminalResult) => {
      expect(received).toBe(payload)
      expect(result).toEqual({ state: 'completed', text: 'done', result: {} })
      return settled
    })
    const workflow = step()

    await expect(
      runDetachedTurnWorkflowTick({
        event: { payload },
        step: workflow.value,
        drive,
        settle,
      }),
    ).resolves.toBe(settled)

    expect(workflow.doStep.mock.calls.map(([name]) => name)).toEqual([
      'detached-turn:drive:0',
      'detached-turn:drive:1',
      'detached-turn:settle',
    ])
    expect(workflow.sleep).toHaveBeenCalledWith('detached-turn:wait:0', '5 seconds')
    expect(drive).toHaveBeenCalledTimes(2)
    expect(settle).toHaveBeenCalledTimes(1)
  })

  it('throws a retryable drive failure from the step and does not settle', async () => {
    const workflow = step()
    const error = new Error('sandbox unavailable')
    const drive = vi.fn(async () => ({ succeeded: false as const, error }))
    const settle = vi.fn()

    await expect(
      runDetachedTurnWorkflowTick({
        event: { payload: { sessionId: 'session-1', turnId: 'turn-1' } },
        step: workflow.value,
        drive,
        settle,
      }),
    ).rejects.toBe(error)
    expect(workflow.doStep).toHaveBeenCalledTimes(1)
    expect(workflow.sleep).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
  })

  it('rejects an unknown drive state instead of persisting it', async () => {
    const workflow = step()
    const drive = vi.fn(async () => ({
      succeeded: true as const,
      value: { state: 'surprise' },
    } as unknown as DetachedTurnDriveOutcome))
    const settle = vi.fn()

    await expect(
      runDetachedTurnWorkflowTick({
        event: { payload: { sessionId: 'session-1', turnId: 'turn-1' } },
        step: workflow.value,
        drive,
        settle,
      }),
    ).rejects.toThrow('unknown state: surprise')
    expect(settle).not.toHaveBeenCalled()
  })

  it('rejects an unstable Workflow identity before opening a drive step', async () => {
    const workflow = step()
    const drive = vi.fn()
    const settle = vi.fn()

    await expect(
      runDetachedTurnWorkflowTick({
        event: { payload: { sessionId: '', turnId: 'turn-1' } },
        step: workflow.value,
        drive,
        settle,
      }),
    ).rejects.toThrow(/non-empty sessionId/)
    expect(workflow.doStep).not.toHaveBeenCalled()
    expect(drive).not.toHaveBeenCalled()
  })
})
