import { describe, expect, it, vi } from 'vitest'
import { ok, fail, type Outcome } from '../sandbox/outcome'
import {
  runWorkflowTurnTick,
  type CloudflareWorkflowStepLike,
  type WorkflowTurnIdentity,
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

describe('runWorkflowTurnTick', () => {
  it('admits once, polls durably, then settles the terminal status', async () => {
    const payload: WorkflowTurnIdentity & { prompt: string } = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      prompt: 'go',
    }
    const workflow = step()
    const admission = { sessionId: payload.sessionId, turnId: payload.turnId, userMessageId: 'u1' }
    const statuses = ['running', 'completed']
    const admit = vi.fn(async (received: typeof payload): Promise<Outcome<typeof admission>> => {
      expect(received).toBe(payload)
      return ok(admission)
    })
    const poll = vi.fn(async (
      received: typeof payload,
      receivedAdmission: typeof admission,
    ): Promise<Outcome<string>> => {
      expect(received).toBe(payload)
      expect(receivedAdmission).toBe(admission)
      return ok(statuses.shift()!)
    })
    const settle = vi.fn(async (received: typeof payload, status: string) => {
      expect(received).toBe(payload)
      expect(status).toBe('completed')
      return { persisted: true }
    })

    await expect(
      runWorkflowTurnTick({
        event: { payload },
        step: workflow.value,
        admit,
        poll,
        isRunning: (status) => status === 'running',
        settle,
      }),
    ).resolves.toEqual({ persisted: true })

    expect(workflow.doStep.mock.calls.map(([name]) => name)).toEqual([
      'workflow-turn:admit',
      'workflow-turn:poll:0',
      'workflow-turn:poll:1',
      'workflow-turn:settle',
    ])
    expect(workflow.sleep).toHaveBeenCalledWith('workflow-turn:wait:0', '5 seconds')
    expect(admit).toHaveBeenCalledTimes(1)
    expect(poll).toHaveBeenCalledTimes(2)
    expect(settle).toHaveBeenCalledTimes(1)
  })

  it('throws an admission transport failure from the durable step', async () => {
    const workflow = step()
    const error = new Error('sandbox unavailable')
    const admit = vi.fn(async () => fail(error))
    const poll = vi.fn()
    const settle = vi.fn()

    await expect(
      runWorkflowTurnTick({
        event: { payload: { sessionId: 'session-1', turnId: 'turn-1' } },
        step: workflow.value,
        admit,
        poll,
        isRunning: () => false,
        settle,
      }),
    ).rejects.toBe(error)
    expect(workflow.doStep).toHaveBeenCalledTimes(1)
    expect(poll).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
  })

  it('rejects an unstable identity before opening a durable step', async () => {
    const workflow = step()
    const admit = vi.fn()
    const poll = vi.fn()
    const settle = vi.fn()

    await expect(
      runWorkflowTurnTick({
        event: { payload: { sessionId: '', turnId: 'turn-1' } },
        step: workflow.value,
        admit,
        poll,
        isRunning: () => false,
        settle,
      }),
    ).rejects.toThrow(/non-empty sessionId/)
    expect(workflow.doStep).not.toHaveBeenCalled()
    expect(admit).not.toHaveBeenCalled()
  })
})
