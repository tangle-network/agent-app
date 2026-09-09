// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import {
  APPLIED_SEQ_CAP,
  createSessionGatewayLane,
  createSessionStreamGrantFetcher,
  gatewayFrameToTurnEvent,
  isGatewayTransportNotice,
  isTerminalGatewayEvent,
  parseSessionStreamGrant,
  type SessionGatewayClientConfigLike,
  type SessionGatewayClientLike,
  type SessionGatewayLiveViewHandlers,
  type SessionStreamGrant,
} from '../../src/web-react/session-gateway'

const messageLaneFrame = (type: string, properties: Record<string, unknown>) => ({
  type,
  properties,
})

const runStreamFrame = (type: string, payload: Record<string, unknown>) => ({
  type,
  ...payload,
})

const terminalFrame = (outcome: Record<string, unknown>) => ({
  outcome,
  tokenUsage: { inputTokens: 10, outputTokens: 20 },
})

const GRANT: SessionStreamGrant = {
  url: 'wss://sandbox.example/session',
  token: 'jwt-read-only',
  sessionId: 'session-1',
  expiresAt: 1_900_000_000,
}

function fakeGatewayClient() {
  const calls = {
    connect: 0,
    disconnect: 0,
    clearReplayState: 0,
    replay: [] as number[],
  }
  let config: SessionGatewayClientConfigLike | null = null
  const client: SessionGatewayClientLike = {
    connect: () => void (calls.connect += 1),
    disconnect: () => void (calls.disconnect += 1),
    replay: (since) => void calls.replay.push(since),
    clearReplayState: () => void (calls.clearReplayState += 1),
  }

  return {
    calls,
    client,
    get config() {
      return config
    },
    create: (nextConfig: SessionGatewayClientConfigLike) => {
      config = nextConfig
      return client
    },
    emit: (data: unknown, sequenceId?: number) =>
      config?.handlers?.onAgentEvent?.(`session:${config.sessionId}`, data, sequenceId),
    backpressure: (dropped: number, since: number) =>
      config?.handlers?.onBackpressureWarning?.(dropped, since, dropped),
    fail: (message: string, code?: string) => config?.handlers?.onError?.(message, code),
    expire: () => config?.handlers?.onTokenExpired?.(),
  }
}

function recordingHandlers(signal = new AbortController().signal) {
  const state = {
    events: [] as Array<{ type: string; data?: Record<string, unknown> }>,
    firstTurnEvent: 0,
    terminal: 0,
    unusable: [] as string[],
  }
  const handlers: SessionGatewayLiveViewHandlers = {
    signal,
    onEvent: (event) => state.events.push(event),
    onFirstTurnEvent: () => void (state.firstTurnEvent += 1),
    onTerminal: () => void (state.terminal += 1),
    onUnusable: (reason) => state.unusable.push(reason),
  }
  return { handlers, state }
}

describe('gatewayFrameToTurnEvent', () => {
  it('reads message-lane payloads from properties', () => {
    expect(
      gatewayFrameToTurnEvent(
        messageLaneFrame('message.part.updated', { part: { id: 'p1' }, delta: 'Hello' }),
      ),
    ).toEqual({
      type: 'message.part.updated',
      data: { part: { id: 'p1' }, delta: 'Hello' },
    })
  })

  it('reads run-stream payloads from inline fields', () => {
    expect(gatewayFrameToTurnEvent(runStreamFrame('token', { value: 'Step 1' }))).toEqual({
      type: 'token',
      data: { value: 'Step 1' },
    })
  })

  it('re-types a typeless terminal frame and preserves its payload', () => {
    const frame = terminalFrame({ status: 'completed' })
    expect(gatewayFrameToTurnEvent(frame)).toEqual({ type: 'done', data: frame })
  })

  it('rejects frames without a type or completion outcome', () => {
    expect(gatewayFrameToTurnEvent({ foo: 'bar' })).toBeNull()
    expect(gatewayFrameToTurnEvent(null)).toBeNull()
    expect(gatewayFrameToTurnEvent(['a'])).toBeNull()
  })
})

describe('gateway event classification', () => {
  it('classifies terminal and transport-notice types', () => {
    for (const type of ['done', 'error', 'result', 'session.run.completed', 'session.run.failed']) {
      expect(isTerminalGatewayEvent(type)).toBe(true)
    }
    for (const type of ['connection.established', 'heartbeat', 'ping', 'pong']) {
      expect(isGatewayTransportNotice(type)).toBe(true)
    }
    expect(isTerminalGatewayEvent('text')).toBe(false)
    expect(isGatewayTransportNotice('text')).toBe(false)
  })
})

describe('parseSessionStreamGrant', () => {
  it('accepts a complete WebSocket grant', () => {
    expect(parseSessionStreamGrant({ available: true, ...GRANT })).toEqual(GRANT)
  })

  it('rejects unavailable, incomplete, malformed, and non-WebSocket grants', () => {
    expect(parseSessionStreamGrant({ available: false, reason: 'sandbox-absent' })).toBeNull()
    expect(parseSessionStreamGrant({ available: true, token: 'x', sessionId: 'y' })).toBeNull()
    expect(parseSessionStreamGrant({ available: true, ...GRANT, url: '' })).toBeNull()
    expect(parseSessionStreamGrant({ available: true, ...GRANT, url: 'https://example.test' })).toBeNull()
    expect(parseSessionStreamGrant({ available: true, ...GRANT, expiresAt: -1 })).toBeNull()
    expect(parseSessionStreamGrant(null)).toBeNull()
  })
})

describe('createSessionStreamGrantFetcher', () => {
  const signal = new AbortController().signal

  it('resolves a grant and passes the scope URL and request options', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.credentials).toBe('include')
      expect(init?.signal).toBe(signal)
      return Response.json({ available: true, ...GRANT })
    })
    const fetcher = createSessionStreamGrantFetcher({
      url: (scopeId) => `/api/sessions/${scopeId}/stream-token`,
      scopeId: 'session-9',
      fetchImpl,
      requestInit: { credentials: 'include' },
    })

    expect(await fetcher(signal)).toEqual(GRANT)
    expect(fetchImpl).toHaveBeenCalledWith('/api/sessions/session-9/stream-token', {
      credentials: 'include',
      signal,
    })
  })

  it('turns every grant-fetch failure into a soft miss', async () => {
    const soft = async (fetchImpl: typeof fetch) =>
      createSessionStreamGrantFetcher({ url: '/grant', scopeId: 'session-1', fetchImpl })(signal)

    await expect(
      soft((async () => Response.json({ available: false })) as typeof fetch),
    ).resolves.toBeNull()
    await expect(
      soft((async () => new Response('nope', { status: 500 })) as typeof fetch),
    ).resolves.toBeNull()
    await expect(
      soft((async () => {
        throw new Error('offline')
      }) as typeof fetch),
    ).resolves.toBeNull()
    await expect(
      soft((async () => new Response('not json', { status: 200 })) as typeof fetch),
    ).resolves.toBeNull()
  })
})

describe('createSessionGatewayLane', () => {
  it('configures the SDK with the read-only grant and forwards events', async () => {
    const fake = fakeGatewayClient()
    const { handlers, state } = recordingHandlers()
    const lane = createSessionGatewayLane({
      fetchGrant: async () => GRANT,
      createClient: fake.create,
      replayStorage: null,
    })

    const attachment = await lane(handlers)
    expect(attachment).not.toBeNull()
    expect(fake.calls.connect).toBe(1)
    expect(fake.config?.url).toBe(GRANT.url)
    expect(fake.config?.token).toBe(GRANT.token)
    expect(fake.config?.sessionId).toBe(GRANT.sessionId)
    expect(fake.config?.autoReconnect).toBe(true)

    fake.emit(messageLaneFrame('message.part.updated', { delta: 'Hello' }), 1)
    fake.emit(terminalFrame({ status: 'completed' }), 2)

    expect(state.events.map((event) => event.type)).toEqual(['message.part.updated', 'done'])
    expect(state.terminal).toBe(1)
  })

  it('does not count transport notices as first-turn feedback', async () => {
    const fake = fakeGatewayClient()
    const { handlers, state } = recordingHandlers()
    await createSessionGatewayLane({
      fetchGrant: async () => GRANT,
      createClient: fake.create,
      replayStorage: null,
    })(handlers)

    fake.emit({ type: 'connection.established' }, 1)
    fake.emit({ type: 'heartbeat' }, 2)
    expect(state.firstTurnEvent).toBe(0)
    expect(state.events).toEqual([])

    fake.emit(messageLaneFrame('message.part.updated', { delta: 'x' }), 3)
    expect(state.firstTurnEvent).toBe(1)
  })

  it('uses a sequence set so replay fills holes without duplicating overlaps', async () => {
    const fake = fakeGatewayClient()
    const { handlers, state } = recordingHandlers()
    await createSessionGatewayLane({
      fetchGrant: async () => GRANT,
      createClient: fake.create,
      replayStorage: null,
    })(handlers)

    const frame = (sequenceId: number) => messageLaneFrame('token', { value: `v${sequenceId}` })
    fake.emit(frame(1), 1)
    fake.emit(frame(2), 2)
    fake.emit(frame(5), 5)
    fake.emit(frame(3), 3)
    fake.emit(frame(4), 4)
    fake.emit(frame(5), 5)

    expect(state.events.map((event) => event.data?.value)).toEqual(['v1', 'v2', 'v5', 'v3', 'v4'])
  })

  it('requests replay after a backpressure warning', async () => {
    const fake = fakeGatewayClient()
    const { handlers } = recordingHandlers()
    await createSessionGatewayLane({
      fetchGrant: async () => GRANT,
      createClient: fake.create,
      replayStorage: null,
    })(handlers)

    fake.backpressure(12, 42)
    expect(fake.calls.replay).toEqual([42])
  })

  it('reports replay failure instead of leaving an unhandled rejection', async () => {
    const fake = fakeGatewayClient()
    const replayError = new Error('socket closed')
    fake.client.replay = () => Promise.reject(replayError)
    const { handlers, state } = recordingHandlers()
    await createSessionGatewayLane({
      fetchGrant: async () => GRANT,
      createClient: fake.create,
      replayStorage: null,
    })(handlers)

    fake.backpressure(1, 7)
    await Promise.resolve()
    expect(state.unusable).toEqual(['replay failed: socket closed'])
  })

  it('returns the token refresher result to the SDK without updating twice', async () => {
    const fake = fakeGatewayClient()
    const { handlers } = recordingHandlers()
    const refreshed = { ...GRANT, token: 'jwt-refreshed', expiresAt: 1_900_000_900 }
    const fetchGrant = vi
      .fn<() => Promise<SessionStreamGrant | null>>()
      .mockResolvedValueOnce(GRANT)
      .mockResolvedValueOnce(refreshed)

    await createSessionGatewayLane({
      fetchGrant,
      createClient: fake.create,
      replayStorage: null,
    })(handlers)

    await expect(fake.config?.onTokenRefresh?.()).resolves.toEqual({
      token: refreshed.token,
      expiresAt: refreshed.expiresAt,
    })
    expect(fetchGrant).toHaveBeenCalledTimes(2)
  })

  it('rejects token refresh when the product cannot mint a replacement', async () => {
    const fake = fakeGatewayClient()
    const { handlers } = recordingHandlers()
    const fetchGrant = vi
      .fn<() => Promise<SessionStreamGrant | null>>()
      .mockResolvedValueOnce(GRANT)
      .mockResolvedValueOnce(null)

    await createSessionGatewayLane({
      fetchGrant,
      createClient: fake.create,
      replayStorage: null,
    })(handlers)

    await expect(fake.config?.onTokenRefresh?.()).rejects.toThrow('stream token refresh unavailable')
  })

  it('reports token expiry and SDK errors as unusable', async () => {
    const fake = fakeGatewayClient()
    const { handlers, state } = recordingHandlers()
    await createSessionGatewayLane({
      fetchGrant: async () => GRANT,
      createClient: fake.create,
      replayStorage: null,
    })(handlers)

    fake.expire()
    fake.fail('connection rejected', 'E_AUTH')
    expect(state.unusable).toEqual(['token expired', 'E_AUTH: connection rejected'])
  })

  it('returns null without creating a client when no grant is available', async () => {
    const createClient = vi.fn()
    const { handlers } = recordingHandlers()
    const attachment = await createSessionGatewayLane({
      fetchGrant: async () => null,
      createClient: createClient as never,
    })(handlers)

    expect(attachment).toBeNull()
    expect(createClient).not.toHaveBeenCalled()
  })

  it('does not connect when the caller aborts while fetching the grant', async () => {
    const fake = fakeGatewayClient()
    const controller = new AbortController()
    const { handlers } = recordingHandlers(controller.signal)
    const attachment = await createSessionGatewayLane({
      fetchGrant: async () => {
        controller.abort()
        return GRANT
      },
      createClient: fake.create,
      replayStorage: null,
    })(handlers)

    expect(attachment).toBeNull()
    expect(fake.calls.connect).toBe(0)
  })

  it('clears SDK replay state and disconnects exactly once on close', async () => {
    const fake = fakeGatewayClient()
    const { handlers } = recordingHandlers()
    const attachment = await createSessionGatewayLane({
      fetchGrant: async () => GRANT,
      createClient: fake.create,
      replayStorage: null,
    })(handlers)

    attachment?.close()
    attachment?.close()
    expect(fake.calls.clearReplayState).toBe(1)
    expect(fake.calls.disconnect).toBe(1)
  })

  it('uses localStorage by default and supports a bounded sequence set', async () => {
    const fake = fakeGatewayClient()
    const { handlers, state } = recordingHandlers()
    await createSessionGatewayLane({
      fetchGrant: async () => GRANT,
      createClient: fake.create,
      appliedSeqCap: 2,
    })(handlers)

    expect(fake.config?.enableReplayPersistence).toBe(true)
    expect(fake.config?.replayStorage).toBe(window.localStorage)

    const frame = messageLaneFrame('token', { value: 'v' })
    fake.emit(frame, 1)
    fake.emit(frame, 2)
    fake.emit(frame, 3)
    fake.emit(frame, 3)
    expect(state.events).toHaveLength(4)
    expect(APPLIED_SEQ_CAP).toBe(100_000)
  })
})
