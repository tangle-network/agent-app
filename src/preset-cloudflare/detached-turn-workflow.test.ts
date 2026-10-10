import { afterEach, describe, expect, it, vi } from 'vitest'
import { SandboxTransientDeadlineError } from '../sandbox/transient-failure'
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
      expect(received).toStrictEqual(payload)
      expect(received).not.toBe(payload)
      expect(Object.isFrozen(received)).toBe(true)
      return states.shift()!
    })
    const settled = { persisted: true }
    const settle = vi.fn(async (received: typeof payload, result: DetachedTurnTerminalResult) => {
      expect(received).toStrictEqual(payload)
      expect(received).not.toBe(payload)
      expect(Object.isFrozen(received)).toBe(true)
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

  // Sandbox 0.49 reports these settled outcomes as their own states; 0.45
  // reported them as `failed`. Either way the turn is over for this Workflow.
  it.each([
    { state: 'blocked_on_approval', approval: {}, result: {} },
    { state: 'awaiting_question', question: {}, result: {} },
    { state: 'awaiting_interaction', interaction: {}, result: {} },
  ])('settles a turn the SDK reports as $state', async (value) => {
    const workflow = step()
    const drive = vi.fn(async () => ({ succeeded: true as const, value } as unknown as DetachedTurnDriveOutcome))
    const settle = vi.fn(async (_payload: unknown, result: DetachedTurnTerminalResult) => result.state)

    await expect(
      runDetachedTurnWorkflowTick({
        event: { payload: { sessionId: 'session-1', turnId: 'turn-1' } },
        step: workflow.value,
        drive,
        settle,
      }),
    ).resolves.toBe(value.state)
    expect(drive).toHaveBeenCalledTimes(1)
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

  describe('transient Sandbox failures', () => {
    afterEach(() => { vi.useRealTimers() })

    /** A step whose sleep moves the clock, so passes see the time a Workflow would. */
    function clockStep() {
      const workflow = step()
      workflow.sleep.mockImplementation(async (_name: string, duration: string | number) => {
        vi.setSystemTime(Date.now() + Number(duration))
      })
      return workflow
    }
    const notReady = () => Object.assign(new Error('Sandbox filesystem incarnation is not ready'), {
      name: 'StateError', code: 'FILESYSTEM_INCARNATION_NOT_READY',
    })

    it('waits out an eight-minute not-ready window and settles the turn', async () => {
      // GTM's busiest box answered not-ready from 10:37 to 10:45 UTC on
      // 2026-10-10; two completion Workflows failed five minutes in.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-10T10:37:04Z'))
      const recoveredAt = Date.parse('2026-10-10T10:45:00Z')
      const workflow = clockStep()
      const drive = vi.fn(async (): Promise<DetachedTurnDriveOutcome> => {
        if (Date.now() < recoveredAt) throw notReady()
        return { succeeded: true, value: { state: 'completed', text: 'done', result: {} } }
      })
      const settle = vi.fn(async (_payload: unknown, result: DetachedTurnTerminalResult) => result.state)

      await expect(runDetachedTurnWorkflowTick({
        event: { payload: { sessionId: 'session-1', turnId: 'turn-1' } },
        step: workflow.value,
        drive,
        settle,
      })).resolves.toBe('completed')

      const waits = workflow.sleep.mock.calls.map(([, duration]) => duration)
      expect(waits.slice(0, 6)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000])
      expect(waits.every((duration) => Number(duration) <= 60_000)).toBe(true)
      expect(Date.now()).toBeGreaterThanOrEqual(recoveredAt)
      expect(Date.now() - recoveredAt).toBeLessThanOrEqual(60_000)
      expect(settle).toHaveBeenCalledTimes(1)
    })

    it('fails with a typed error once one not-ready stretch outlasts fifteen minutes', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const startedAt = Date.parse('2026-10-10T10:37:04Z')
      vi.setSystemTime(startedAt)
      const workflow = clockStep()
      const drive = vi.fn(async (): Promise<DetachedTurnDriveOutcome> => { throw notReady() })
      const settle = vi.fn()

      const failure = await runDetachedTurnWorkflowTick({
        event: { payload: { sessionId: 'session-1', turnId: 'turn-1' } },
        step: workflow.value,
        drive,
        settle,
      }).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(SandboxTransientDeadlineError)
      expect(failure).toMatchObject({ code: 'sandbox.filesystem_not_ready', firstSeenAt: startedAt })
      expect(Date.now() - startedAt).toBeGreaterThan(14 * 60_000)
      expect(Date.now() - startedAt).toBeLessThanOrEqual(15 * 60_000)
      expect(settle).not.toHaveBeenCalled()
    })

    it('starts a new stretch after a pass the Sandbox answers', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-10T10:37:04Z'))
      const workflow = clockStep()
      const passes: Array<'not-ready' | 'running' | 'completed'> = ['not-ready', 'not-ready', 'running', 'not-ready', 'completed']
      const drive = vi.fn(async (): Promise<DetachedTurnDriveOutcome> => {
        const next = passes.shift()!
        if (next === 'not-ready') throw notReady()
        return { succeeded: true, value: next === 'running' ? { state: 'running', elapsedMs: 1 } : { state: 'completed', text: 'done', result: {} } }
      })

      await runDetachedTurnWorkflowTick({
        event: { payload: { sessionId: 'session-1', turnId: 'turn-1' } },
        step: workflow.value,
        drive,
        settle: async () => 'settled',
      })

      expect(workflow.sleep.mock.calls.map(([, duration]) => duration)).toEqual([5_000, 10_000, '5 seconds', 5_000])
    })

    it('throws an unclassified failure from the step when the policy is off', async () => {
      const workflow = step()
      const error = notReady()
      await expect(runDetachedTurnWorkflowTick({
        event: { payload: { sessionId: 'session-1', turnId: 'turn-1' } },
        step: workflow.value,
        drive: async () => ({ succeeded: false as const, error }),
        settle: vi.fn(),
        transient: false,
      })).rejects.toBe(error)
    })
  })
})

