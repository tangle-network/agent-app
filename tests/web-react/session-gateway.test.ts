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
  type SessionStreamGrant,
} from '../../src/web-react/session-gateway'
import type { LiveLaneHandlers } from '../../src/web-react/turn-recovery'

// ── frame fixtures, shaped after real production captures ─────────────────

/** session-MESSAGE lane: payload lives under `properties`. */
const messageLaneFrame = (type: string, properties: Record<string, unknown>) => ({
  type,
  properties,
})
/** run/stream replay: payload is inline, no wrapper. */
const runStreamFrame = (type: string, payload: Record<string, unknown>) => ({ type, ...payload })
/** The terminal frame carries NO type — `broadcast()` clobbers it. */
const terminalFrame = (outcome: Record<string, unknown>) => ({
  outcome,
  tokenUsage: { inputTokens: 10, outputTokens: 20 },
})

const GRANT: SessionStreamGrant = {
  url: 'wss://sandbox.tangle.tools/session',
  token: 'jwt-read-only',
  sessionId: 't-gateway',
  expiresAt: 1_900_000_000,
}

/** A structural stand-in for the SDK client — no `vi.mock`, no SDK install. */
function fakeGatewayClient() {
  const calls = {
    connect: 0,
    disconnect: 0,
    clearReplayState: 0,
    replay: [] as number[],
    updateToken: [] as string[],
  }
  let config: SessionGatewayClientConfigLike | null = null
  const client: SessionGatewayClientLike = {
    connect: () => void (calls.connect += 1),
    disconnect: () => void (calls.disconnect += 1),
    replay: (since) => void calls.replay.push(since),
    clearReplayState: () => void (calls.clearReplayState += 1),
    updateToken: (t) => void calls.updateToken.push(t),
  }
  return {
    calls,
    client,
    get config() {
      return config
    },
    create: (c: SessionGatewayClientConfigLike) => {
      config = c
      return client
    },
    /** Deliver a frame the way the SDK does: channel FIRST, then data, then seq. */
    emit: (data: unknown, seq?: number) =>
      config?.handlers?.onAgentEvent?.(`session:${config.sessionId}`, data, seq),
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
  const handlers: LiveLaneHandlers = {
    turnId: 't1',
    signal,
    onEvent: (e) => state.events.push(e),
    onFirstTurnEvent: () => void (state.firstTurnEvent += 1),
    onTerminal: () => void (state.terminal += 1),
    onUnusable: (reason) => state.unusable.push(reason),
  }
  return { handlers, state }
}

// ── frame decoding ────────────────────────────────────────────────────────

describe('gatewayFrameToTurnEvent', () => {
  it('reads the message lane payload out of `properties`', () => {
    expect(
      gatewayFrameToTurnEvent(
        messageLaneFrame('message.part.updated', { part: { id: 'p1' }, delta: 'Hello' }),
      ),
    ).toEqual({ type: 'message.part.updated', data: { part: { id: 'p1' }, delta: 'Hello' } })
  })

  it('reads a run/stream replay payload inline, with no properties wrapper', () => {
    expect(gatewayFrameToTurnEvent(runStreamFrame('token', { value: 'Step 1' }))).toEqual({
      type: 'token',
      data: { value: 'Step 1' },
    })
  })

  it('re-types the typeless terminal frame as `done`, keeping outcome and usage', () => {
    const frame = terminalFrame({ status: 'completed' })
    expect(gatewayFrameToTurnEvent(frame)).toEqual({ type: 'done', data: frame })
  })

  it('rejects a frame with neither a type nor an outcome', () => {
    expect(gatewayFrameToTurnEvent({ foo: 'bar' })).toBeNull()
    expect(gatewayFrameToTurnEvent(null)).toBeNull()
    expect(gatewayFrameToTurnEvent(['a'])).toBeNull()
  })
})

describe('gateway event classification', () => {
  it('classifies terminals and transport notices', () => {
    for (const t of ['done', 'error', 'result', 'session.run.completed', 'session.run.failed']) {
      expect(isTerminalGatewayEvent(t)).toBe(true)
    }
    for (const t of ['connection.established', 'heartbeat', 'ping', 'pong']) {
      expect(isGatewayTransportNotice(t)).toBe(true)
    }
    expect(isTerminalGatewayEvent('text')).toBe(false)
    expect(isGatewayTransportNotice('text')).toBe(false)
  })
})

// ── the grant ─────────────────────────────────────────────────────────────

describe('parseSessionStreamGrant', () => {
  it('accepts a complete positive grant', () => {
    expect(parseSessionStreamGrant({ available: true, ...GRANT })).toEqual(GRANT)
  })

  it('rejects every negative or incomplete shape', () => {
    expect(parseSessionStreamGrant({ available: false, reason: 'sandbox-absent' })).toBeNull()
    expect(parseSessionStreamGrant({ available: true, token: 'x', sessionId: 'y' })).toBeNull()
    expect(parseSessionStreamGrant({ available: true, ...GRANT, url: '' })).toBeNull()
    expect(parseSessionStreamGrant(null)).toBeNull()
  })
})

describe('createSessionStreamGrantFetcher', () => {
  const signal = new AbortController().signal

  it('resolves the grant and calls the product endpoint for the scope', async () => {
    const fetchImpl = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json({ available: true, ...GRANT }),
    )
    const fetcher = createSessionStreamGrantFetcher({
      url: (scopeId) => `/api/threads/${scopeId}/stream-token`,
      scopeId: 'thread-9',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(await fetcher(signal)).toEqual(GRANT)
    expect(fetchImpl.mock.calls[0]![0]).toBe('/api/threads/thread-9/stream-token')
  })

  it('never throws — every failure mode is a soft miss', async () => {
    const soft = async (impl: typeof fetch) =>
      createSessionStreamGrantFetcher({ url: '/g', scopeId: 's', fetchImpl: impl })(signal)

    await expect(
      soft((async () => Response.json({ available: false, reason: 'sandbox-absent' })) as typeof fetch),
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

// ── the lane ──────────────────────────────────────────────────────────────

describe('createSessionGatewayLane', () => {
  it('hands the browser a read-only token and forwards decoded turn events', async () => {
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
    // The browser must never see a sandbox API key.
    expect(fake.config!.token).toBe('jwt-read-only')
    expect(fake.config!.autoReconnect).toBe(true)

    fake.emit(messageLaneFrame('message.part.updated', { delta: 'Hello' }), 1)
    fake.emit(terminalFrame({ status: 'completed' }), 2)

    expect(state.events.map((e) => e.type)).toEqual(['message.part.updated', 'done'])
    expect(state.terminal).toBe(1)
  })

  it('fires onFirstTurnEvent only after the transport-notice filter', async () => {
    // A heartbeat proves the SOCKET is alive, never that the TURN is publishing.
    // If it counted as liveness the silence guard would never trip on a
    // detached run and the durable lane would never take over.
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

  it('dedupes by seq with a Set, so a backpressure replay still fills its hole', async () => {
    // A high-water mark would drop the very frames `replay(since)` was asked to
    // refill. This is the case GTM's own suite cannot reach — its fake always
    // auto-increments seq, so a duplicate is unproducible.
    const fake = fakeGatewayClient()
    const { handlers, state } = recordingHandlers()
    await createSessionGatewayLane({
      fetchGrant: async () => GRANT,
      createClient: fake.create,
      replayStorage: null,
    })(handlers)

    const at = (n: number) => messageLaneFrame('token', { value: `v${n}` })
    fake.emit(at(1), 1)
    fake.emit(at(2), 2)
    fake.emit(at(5), 5)
    // The hole (3,4) is refilled and 5 overlaps — only the overlap drops.
    fake.emit(at(3), 3)
    fake.emit(at(4), 4)
    fake.emit(at(5), 5)

    expect(state.events.map((e) => e.data!.value)).toEqual(['v1', 'v2', 'v5', 'v3', 'v4'])
  })

  it('asks the gateway to refill a backpressure gap', async () => {
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

  it('re-mints on token refresh and pushes the new token into the client', async () => {
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

    await expect(fake.config!.onTokenRefresh!()).resolves.toEqual({
      token: 'jwt-refreshed',
      expiresAt: 1_900_000_900,
    })
    expect(fake.calls.updateToken).toEqual(['jwt-refreshed'])
  })

  it('rejects a refresh it cannot mint, so the SDK surfaces the expiry', async () => {
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
    await expect(fake.config!.onTokenRefresh!()).rejects.toThrow('stream token refresh unavailable')
  })

  it('reports an expired token and a socket error as unusable', async () => {
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

  it('returns null without constructing a client when no session is attachable', async () => {
    const createClient = vi.fn()
    const { handlers } = recordingHandlers()
    const attachment = await createSessionGatewayLane({
      fetchGrant: async () => null,
      createClient: createClient as never,
    })(handlers)

    expect(attachment).toBeNull()
    expect(createClient).not.toHaveBeenCalled()
  })

  it('tears down the replay cursor and the socket on close', async () => {
    const fake = fakeGatewayClient()
    const { handlers } = recordingHandlers()
    const attachment = await createSessionGatewayLane({
      fetchGrant: async () => GRANT,
      createClient: fake.create,
      replayStorage: null,
    })(handlers)

    attachment!.close()
    expect(fake.calls.clearReplayState).toBe(1)
    expect(fake.calls.disconnect).toBe(1)
  })

  it('enables replay persistence when a storage is available', async () => {
    const fake = fakeGatewayClient()
    const { handlers } = recordingHandlers()
    await createSessionGatewayLane({
      fetchGrant: async () => GRANT,
      createClient: fake.create,
    })(handlers)
    // jsdom supplies window.localStorage.
    expect(fake.config!.enableReplayPersistence).toBe(true)
    expect(fake.config!.replayStorage).toBe(window.localStorage)
  })

  it('does not connect when the follow was aborted while the grant was in flight', async () => {
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

  it('caps the dedupe set so a very long turn cannot grow it without bound', async () => {
    const fake = fakeGatewayClient()
    const { handlers, state } = recordingHandlers()
    await createSessionGatewayLane({
      fetchGrant: async () => GRANT,
      createClient: fake.create,
      replayStorage: null,
      appliedSeqCap: 2,
    })(handlers)

    const frame = () => messageLaneFrame('token', { value: 'v' })
    fake.emit(frame(), 1)
    fake.emit(frame(), 2)
    fake.emit(frame(), 3) // past the cap: recorded no longer, but still forwarded
    fake.emit(frame(), 3) // and therefore no longer suppressed
    expect(state.events).toHaveLength(4)
    expect(APPLIED_SEQ_CAP).toBe(100_000)
  })
})
