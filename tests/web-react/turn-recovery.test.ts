import { describe, expect, it, vi } from 'vitest'
import {
  chatStreamLaneListener,
  discoverRunningTurn,
  drainNdjsonLines,
  followDurableTurn,
  followTurn,
  parseRunningTurnResponse,
  type LiveLaneConnector,
  type LiveLaneHandlers,
  type RecoveredTurnEvent,
  type TurnResetReason,
} from '../../src/web-react/turn-recovery'

// ── fixtures ──────────────────────────────────────────────────────────────

/** A replayed line as `stampReplaySeq` emits it: buffer ordinal on the line. */
const textLine = (seq: number, text: string) =>
  JSON.stringify({ seq, kind: 'event', event: { type: 'text', text } })

/** The terminator `replayTurnEvents` ends a window with — deliberately unstamped. */
const sentinel = (status: 'complete' | 'error' | 'unknown' | 'timeout') =>
  JSON.stringify({ type: 'turn_status', status })

interface NdjsonOptions {
  /** Error the stream after this many lines, simulating a transport drop. */
  failAfter?: number
}

function ndjsonResponse(lines: string[], options: NdjsonOptions = {}): Response {
  let i = 0
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (options.failAfter !== undefined && i === options.failAfter) {
        controller.error(new Error('transport dropped'))
        return
      }
      if (i >= lines.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(`${lines[i]}\n`))
      i += 1
    },
  })
  return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } })
}

/** Accumulate the text a consumer would render, so inflation is measurable. */
function textAccumulator() {
  let text = ''
  const listener = chatStreamLaneListener({ onText: (delta) => (text += delta) })
  return {
    onEvent: (event: RecoveredTurnEvent) => listener(event),
    reset: () => {
      text = ''
    },
    get text() {
      return text
    },
  }
}

/** A scripted live lane. `script` runs once the connector is attached. */
function fakeLiveLane(script: (handlers: LiveLaneHandlers) => void | Promise<void>) {
  const state = { attached: 0, closed: 0 }
  const connector: LiveLaneConnector = async (handlers) => {
    state.attached += 1
    void script(handlers)
    return {
      close: () => {
        state.closed += 1
      },
    }
  }
  return { connector, state }
}

/** Tight timings so the suite runs on real timers — fake timers plus the
 *  abort-aware sleep interleaving is where these suites rot. */
const FAST = {
  liveSilenceTimeoutMs: 40,
  settlePollIntervalMs: 5,
  livenessPollTicks: 2,
  reconnectDelayMs: 5,
}

// ── the parse/drain primitives ────────────────────────────────────────────

describe('drainNdjsonLines', () => {
  it('carries a partial line across chunks and flushes it at EOF', async () => {
    const encoder = new TextEncoder()
    const chunks = ['{"a":1}\n{"b":', '2}\n{"c":3}']
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c))
        controller.close()
      },
    })
    const lines: string[] = []
    await drainNdjsonLines(body, (line) => lines.push(line))
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
  })

  it('propagates a transport failure so the caller can resume', async () => {
    await expect(drainNdjsonLines(ndjsonResponse(['{"a":1}'], { failAfter: 0 }).body!, () => {}))
      .rejects.toThrow('transport dropped')
  })
})

describe('parseRunningTurnResponse', () => {
  it('accepts the shared {running: string[]} contract and rejects everything else', () => {
    expect(parseRunningTurnResponse({ running: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(parseRunningTurnResponse({ running: ['a', 2, '', null] })).toEqual(['a'])
    expect(parseRunningTurnResponse({})).toEqual([])
    expect(parseRunningTurnResponse(null)).toEqual([])
  })
})

// ── AC: no running turn / discovery failure ───────────────────────────────

describe('discoverRunningTurn', () => {
  it('reports no running turn without throwing', async () => {
    const result = await discoverRunningTurn(async () => [], new AbortController().signal)
    expect(result).toEqual({ succeeded: true, turnId: null })
  })

  it('takes the first (newest) running turn', async () => {
    const result = await discoverRunningTurn(
      async () => ['newest', 'older'],
      new AbortController().signal,
    )
    expect(result).toEqual({ succeeded: true, turnId: 'newest' })
  })

  it('distinguishes "could not ask" from "nothing running" — products gate on it', async () => {
    const result = await discoverRunningTurn(async () => {
      throw new Error('HTTP 500')
    }, new AbortController().signal)
    expect(result).toEqual({ succeeded: false, error: 'HTTP 500' })
  })
})

// ── AC: durable-only lane ─────────────────────────────────────────────────

describe('followDurableTurn', () => {
  it('streams a turn to completion and reports the sentinel status', async () => {
    const acc = textAccumulator()
    const openReplay = vi.fn<(turnId: string, fromSeq: number) => Promise<Response>>(async () =>
      ndjsonResponse([textLine(1, 'Hello '), textLine(2, 'world'), sentinel('complete')]),
    )
    const result = await followDurableTurn({
      turnId: 't1',
      openReplay,
      listRunning: async () => ['t1'],
      onEvent: acc.onEvent,
      ...FAST,
    })
    expect(result).toEqual({ turnId: 't1', lane: 'durable', status: 'complete', fellBack: false })
    expect(acc.text).toBe('Hello world')
    expect(openReplay).toHaveBeenCalledTimes(1)
    expect(openReplay.mock.calls[0]![1]).toBe(0)
  })

  it('surfaces an error sentinel as an error status', async () => {
    const result = await followDurableTurn({
      turnId: 't1',
      openReplay: async () => ndjsonResponse([textLine(1, 'partial'), sentinel('error')]),
      listRunning: async () => [],
      onEvent: () => {},
      ...FAST,
    })
    expect(result.status).toBe('error')
  })

  it('never forwards the turn_status sentinel as a transcript event', async () => {
    const types: string[] = []
    await followDurableTurn({
      turnId: 't1',
      openReplay: async () => ndjsonResponse([textLine(1, 'hi'), sentinel('complete')]),
      listRunning: async () => ['t1'],
      onEvent: (e) => types.push(e.type),
      ...FAST,
    })
    expect(types).toEqual(['text'])
  })
})

// ── AC: reconnect continuation + mid-turn drop and resume ─────────────────

describe('durable cursor continuation', () => {
  it('reconnects from the last delivered seq when the follow window times out', async () => {
    const acc = textAccumulator()
    const openReplay = vi
      .fn<(turnId: string, fromSeq: number) => Promise<Response>>()
      .mockResolvedValueOnce(
        ndjsonResponse([textLine(1, 'one '), textLine(2, 'two '), sentinel('timeout')]),
      )
      .mockResolvedValueOnce(ndjsonResponse([textLine(3, 'three'), sentinel('complete')]))

    const result = await followDurableTurn({
      turnId: 't1',
      openReplay,
      listRunning: async () => ['t1'], // still running: the window expired, not the turn
      onEvent: acc.onEvent,
      ...FAST,
    })

    expect(result.status).toBe('complete')
    // The whole point: the second window resumes AFTER seq 2, not from zero.
    expect(openReplay.mock.calls.map((c) => c[1])).toEqual([0, 2])
    expect(acc.text).toBe('one two three') // exactly 1.000x — nothing re-applied
  })

  it('resumes from the cursor after a mid-stream transport drop', async () => {
    const acc = textAccumulator()
    const openReplay = vi
      .fn<(turnId: string, fromSeq: number) => Promise<Response>>()
      // Two good lines, then the socket dies before any sentinel.
      .mockResolvedValueOnce(
        ndjsonResponse([textLine(1, 'one '), textLine(2, 'two '), textLine(3, 'never')], {
          failAfter: 2,
        }),
      )
      .mockResolvedValueOnce(ndjsonResponse([textLine(3, 'three'), sentinel('complete')]))

    const result = await followDurableTurn({
      turnId: 't1',
      openReplay,
      listRunning: async () => ['t1'],
      onEvent: acc.onEvent,
      ...FAST,
    })

    expect(result.status).toBe('complete')
    expect(openReplay.mock.calls.map((c) => c[1])).toEqual([0, 2])
    expect(acc.text).toBe('one two three')
  })

  it('settles when the server says the turn is gone, even with no sentinel', async () => {
    const openReplay = vi.fn(async () => ndjsonResponse([textLine(1, 'done')]))
    const result = await followDurableTurn({
      turnId: 't1',
      openReplay,
      listRunning: async () => [], // gone
      onEvent: () => {},
      ...FAST,
    })
    expect(result.status).toBe('complete')
    expect(openReplay).toHaveBeenCalledTimes(1)
  })

  it('asks the consumer to rebuild when the server does not stamp seq', async () => {
    // A deployment predating `stampReplaySeq`: the cursor cannot advance, so the
    // next window necessarily replays from zero and would double-render.
    const unstamped = (text: string) =>
      JSON.stringify({ kind: 'event', event: { type: 'text', text } })
    const acc = textAccumulator()
    const resets: TurnResetReason[] = []
    const openReplay = vi
      .fn<(turnId: string, fromSeq: number) => Promise<Response>>()
      .mockResolvedValueOnce(ndjsonResponse([unstamped('one '), sentinel('timeout')]))
      .mockResolvedValueOnce(ndjsonResponse([unstamped('one '), unstamped('two'), sentinel('complete')]))

    await followDurableTurn({
      turnId: 't1',
      openReplay,
      listRunning: async () => ['t1'],
      onEvent: (e) => acc.onEvent(e),
      onResetTurn: (reason) => {
        resets.push(reason)
        acc.reset()
      },
      ...FAST,
    })

    expect(resets).toEqual(['resume'])
    expect(openReplay.mock.calls.map((c) => c[1])).toEqual([0, 0])
    expect(acc.text).toBe('one two') // rebuilt, not doubled
  })
})

// ── AC: clean live stream ─────────────────────────────────────────────────

describe('live lane', () => {
  it('serves a clean turn without ever touching the durable replay route', async () => {
    const events: RecoveredTurnEvent[] = []
    const openReplay = vi.fn(async () => ndjsonResponse([]))
    const { connector, state } = fakeLiveLane((h) => {
      h.onFirstTurnEvent()
      h.onEvent({ type: 'message.part.updated', data: { delta: 'Hello' } })
      h.onEvent({ type: 'message.part.updated', data: { delta: ' world' } })
      h.onTerminal()
    })

    let calls = 0
    const result = await followTurn({
      turnId: 't1',
      attachLive: connector,
      openReplay,
      // Running on the first poll, gone on the next — the turn settles live.
      listRunning: async () => (++calls <= 1 ? ['t1'] : []),
      onEvent: (e) => events.push(e),
      ...FAST,
    })

    expect(result).toEqual({ turnId: 't1', lane: 'live', status: 'complete', fellBack: false })
    expect(events.map((e) => e.lane)).toEqual(['live', 'live'])
    expect(openReplay).not.toHaveBeenCalled()
    expect(state.closed).toBe(1)
  })

  // ── AC: silent live lane falls back ─────────────────────────────────────
  it('falls back when the lane is attached but publishes no turn events', async () => {
    // The detached/autonomous case: the socket is healthy, the driver just
    // never publishes to the session bus. Only the silence guard detects it.
    const acc = textAccumulator()
    const resets: TurnResetReason[] = []
    const { connector } = fakeLiveLane((h) => {
      // Transport notices only — these must NOT count as liveness, so the
      // connector deliberately does not call onFirstTurnEvent.
      h.onEvent({ type: 'connection.established' })
    })

    const result = await followTurn({
      turnId: 't1',
      attachLive: connector,
      openReplay: async () => ndjsonResponse([textLine(1, 'relayed'), sentinel('complete')]),
      listRunning: async () => ['t1'], // never settles — only silence can resolve it
      onEvent: acc.onEvent,
      onResetTurn: (r) => {
        resets.push(r)
        acc.reset()
      },
      ...FAST,
    })

    expect(result.lane).toBe('durable')
    expect(result.fellBack).toBe(true)
    expect(result.status).toBe('complete')
    expect(acc.text).toBe('relayed')
    // A notice was forwarded, so the turn state is dirty and must be rebuilt.
    expect(resets).toEqual(['lane-switch'])
  })

  // ── AC: duplicate suppression across lanes ──────────────────────────────
  it('resets before the durable lane replays what the live lane already rendered', async () => {
    const acc = textAccumulator()
    const resets: TurnResetReason[] = []
    const order: string[] = []
    const { connector } = fakeLiveLane((h) => {
      h.onFirstTurnEvent()
      h.onEvent({ type: 'text', data: { text: 'First ' } })
      h.onUnusable('socket died')
    })

    const result = await followTurn({
      turnId: 't1',
      attachLive: connector,
      openReplay: async () =>
        ndjsonResponse([textLine(1, 'First '), textLine(2, 'done'), sentinel('complete')]),
      listRunning: async () => ['t1'],
      onEvent: (e) => {
        order.push(`event:${e.lane}`)
        acc.onEvent(e)
      },
      onResetTurn: (r) => {
        order.push('reset')
        resets.push(r)
        acc.reset()
      },
      ...FAST,
    })

    expect(result.fellBack).toBe(true)
    expect(resets).toEqual(['lane-switch'])
    // The reset must land strictly BEFORE the first durable event.
    expect(order).toEqual(['event:live', 'reset', 'event:durable', 'event:durable'])
    // The anti-inflation pin: the live lane's "First " must not survive.
    expect(acc.text).toBe('First done')
  })

  it('does not ask for a rebuild when the live lane rendered nothing', async () => {
    const resets: TurnResetReason[] = []
    const { connector } = fakeLiveLane((h) => h.onUnusable('no session'))
    const result = await followTurn({
      turnId: 't1',
      attachLive: connector,
      openReplay: async () => ndjsonResponse([textLine(1, 'x'), sentinel('complete')]),
      listRunning: async () => ['t1'],
      onEvent: () => {},
      onResetTurn: (r) => resets.push(r),
      ...FAST,
    })
    expect(result.fellBack).toBe(true)
    expect(resets).toEqual([])
  })

  it('treats a connector that resolves null as a soft miss', async () => {
    const openReplay = vi.fn(async () =>
      ndjsonResponse([textLine(1, 'relayed'), sentinel('complete')]),
    )
    const result = await followTurn({
      turnId: 't1',
      attachLive: async () => null,
      openReplay,
      listRunning: async () => ['t1'],
      onEvent: () => {},
      ...FAST,
    })
    expect(result.lane).toBe('durable')
    expect(openReplay).toHaveBeenCalledTimes(1)
  })

  it('treats a rejecting connector as a soft miss, never a turn failure', async () => {
    const result = await followTurn({
      turnId: 't1',
      attachLive: async () => {
        throw new Error('gateway unreachable')
      },
      openReplay: async () => ndjsonResponse([textLine(1, 'relayed'), sentinel('complete')]),
      listRunning: async () => ['t1'],
      onEvent: () => {},
      ...FAST,
    })
    expect(result.status).toBe('complete')
    expect(result.lane).toBe('durable')
  })

  // ── AC: finish-before-attach ────────────────────────────────────────────
  it('settles a turn that ended before the socket attached, with no terminal event', async () => {
    // No handler is ever invoked: the turn was already over. Only the settle
    // poll — which runs unconditionally from t=0 — can resolve this.
    const openReplay = vi.fn(async () => ndjsonResponse([]))
    const { connector, state } = fakeLiveLane(() => {})
    let calls = 0

    const result = await followTurn({
      turnId: 't-raced',
      attachLive: connector,
      openReplay,
      listRunning: async () => (++calls <= 1 ? ['t-raced'] : []),
      onEvent: () => {},
      ...FAST,
    })

    expect(result.lane).toBe('live')
    expect(openReplay).not.toHaveBeenCalled()
    expect(state.closed).toBe(1)
  })

  it('closes an attachment that opens after the lane already settled', async () => {
    let closed = 0
    const result = await followTurn({
      turnId: 't1',
      attachLive: async () => {
        // Resolve well after the settle poll has already finished the lane.
        await new Promise((r) => setTimeout(r, 30))
        return { close: () => (closed += 1) }
      },
      openReplay: async () => ndjsonResponse([]),
      listRunning: async () => [],
      onEvent: () => {},
      ...FAST,
    })
    expect(result.lane).toBe('live')
    await new Promise((r) => setTimeout(r, 40))
    expect(closed).toBe(1)
  })
})

// ── abort ─────────────────────────────────────────────────────────────────

describe('abort', () => {
  it('stops promptly and forwards nothing after abort', async () => {
    const controller = new AbortController()
    const events: RecoveredTurnEvent[] = []
    const promise = followDurableTurn({
      turnId: 't1',
      signal: controller.signal,
      openReplay: async () => ndjsonResponse([textLine(1, 'x'), sentinel('timeout')]),
      listRunning: async () => ['t1'],
      onEvent: (e) => events.push(e),
      ...FAST,
    })
    setTimeout(() => controller.abort(), 20)
    const result = await promise
    expect(result.status).toBe('aborted')
    const seen = events.length
    await new Promise((r) => setTimeout(r, 30))
    expect(events.length).toBe(seen)
  })
})

// ── the durable-only reducer bridge ───────────────────────────────────────

describe('chatStreamLaneListener', () => {
  it('replays a durable line through the existing chat-stream callbacks', () => {
    const onText = vi.fn()
    const onTurnId = vi.fn()
    const listener = chatStreamLaneListener({ onText, onTurnId })
    listener({ lane: 'durable', type: 'text', line: textLine(1, 'hi') })
    listener({ lane: 'durable', type: 'turn', line: JSON.stringify({ type: 'turn', turnId: 't9' }) })
    expect(onText).toHaveBeenCalledWith('hi')
    expect(onTurnId).toHaveBeenCalledWith('t9')
  })

  it('ignores live-lane events — that vocabulary is the product’s to own', () => {
    const onText = vi.fn()
    chatStreamLaneListener({ onText })({
      lane: 'live',
      type: 'message.part.updated',
      data: { delta: 'raw' },
    })
    expect(onText).not.toHaveBeenCalled()
  })
})
