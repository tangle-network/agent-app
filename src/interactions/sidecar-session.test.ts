import { describe, expect, it, vi } from 'vitest'
import {
  abortSession,
  getSessionState,
  isTerminalSidecarState,
  type SidecarInteractionsConnection,
} from './sidecar'

function connection(fetchImpl: typeof fetch): SidecarInteractionsConnection {
  return {
    runtimeUrl: 'https://rt.example.com',
    authToken: 'tok',
    sessionId: 'sess-1',
    fetchImpl,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('isTerminalSidecarState', () => {
  // The three early returns are the whole point: a session that LOOKS finished
  // by its state string but still has work attached is not finished, and an app
  // that treats it as finished abandons a turn or strands a blocked agent.
  it('is not terminal while an execution is live, whatever the state says', () => {
    expect(isTerminalSidecarState({ state: 'completed', activeExecutionId: 'exec-1' })).toBe(false)
  })

  it('is not terminal while the platform says the session is reconnectable', () => {
    expect(isTerminalSidecarState({ state: 'failed', reconnectable: true })).toBe(false)
  })

  it('is not terminal while an interaction is still unanswered', () => {
    expect(isTerminalSidecarState({ state: 'idle', outstandingInteractions: [{ id: 'i-1' }] })).toBe(false)
  })

  it.each(['completed', 'failed', 'aborted', 'expired', 'idle', 'terminal'])(
    'is terminal for a settled state with nothing attached (%s)',
    (state) => {
      expect(isTerminalSidecarState({ state })).toBe(true)
    },
  )

  it('is terminal when the platform says it cannot be reconnected, whatever the state', () => {
    expect(isTerminalSidecarState({ state: 'running', reconnectable: false })).toBe(true)
  })

  it('is not terminal for an unrecognised state with no other signal', () => {
    expect(isTerminalSidecarState({ state: 'warming' })).toBe(false)
  })
})

describe('getSessionState', () => {
  it('reads a payload nested under data', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      data: { session: { state: 'running', activeExecutionId: 'exec-1', reconnectable: true } },
    }))
    const result = await getSessionState(connection(fetchImpl as unknown as typeof fetch))
    expect(result).toEqual({
      succeeded: true,
      value: { state: 'running', activeExecutionId: 'exec-1', reconnectable: true },
    })
  })

  it('reads a flat payload from an older box', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ state: 'completed' }))
    const result = await getSessionState(connection(fetchImpl as unknown as typeof fetch))
    expect(result).toMatchObject({ succeeded: true, value: { state: 'completed' } })
  })

  // The execution id lives in two places depending on box age, and reading only
  // one of them reports a busy session as idle.
  it('recovers the execution id from activeExecution when the session omits it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      data: { session: { state: 'running' }, activeExecution: { id: 'exec-9', status: 'streaming' } },
    }))
    const result = await getSessionState(connection(fetchImpl as unknown as typeof fetch))
    expect(result).toMatchObject({
      succeeded: true,
      value: { activeExecutionId: 'exec-9', activeExecutionStatus: 'streaming' },
    })
  })

  it('reports an unreachable sidecar as a typed failure, not a throw', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'))
    const result = await getSessionState(connection(fetchImpl as unknown as typeof fetch))
    expect(result).toMatchObject({ succeeded: false, error: { code: 'SIDECAR_UNREACHABLE', status: 502 } })
  })

  it('never leaks a bearer token from an upstream message', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('failed with Bearer sk_live_abcdefgh12345678'))
    const result = await getSessionState(connection(fetchImpl as unknown as typeof fetch))
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.error.message).not.toContain('sk_live_abcdefgh12345678')
    expect(result.error.message).toContain('[redacted]')
  })
})

describe('abortSession', () => {
  it('reports a cancelled session', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { cancelled: true, reason: 'user' } }))
    const result = await abortSession(connection(fetchImpl as unknown as typeof fetch))
    expect(result).toEqual({ succeeded: true, value: { cancelled: true, reason: 'user' } })
    const [url, init] = fetchImpl.mock.calls[0] as [string, { method: string }]
    expect(url).toContain('/abort')
    expect(init.method).toBe('POST')
  })

  // A session the sidecar has never heard of already satisfies "must not be
  // running". Reporting that as an error makes every cancel-after-completion
  // look like an outage.
  it('treats an unknown session as a successful no-op', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'no such session' } }, 404))
    const result = await abortSession(connection(fetchImpl as unknown as typeof fetch))
    expect(result).toEqual({ succeeded: true, value: { cancelled: false, reason: 'not-found' } })
  })

  it('still surfaces a real upstream failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'BOOM', message: 'nope' } }, 500))
    const result = await abortSession(connection(fetchImpl as unknown as typeof fetch))
    expect(result).toMatchObject({ succeeded: false, error: { code: 'BOOM', status: 500 } })
  })
})
