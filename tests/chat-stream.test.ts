import { describe, it, expect, vi } from 'vitest'
import {
  consumeChatStream,
  defaultReconnectDelayMs,
  dispatchChatStreamLine,
  streamChatTurn,
  type ChatReasoningState,
  type ChatStreamCallbacks,
  type ProducerWireEvent,
} from '../src/web-react/chat-stream'

function ndjsonBody(lines: unknown[], opts?: { failAfter?: number }): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (opts?.failAfter != null && i >= opts.failAfter) {
        controller.error(new Error('network reset'))
        return
      }
      if (i >= lines.length) {
        controller.close()
        return
      }
      controller.enqueue(enc.encode(JSON.stringify(lines[i++]) + '\n'))
    },
  })
}

function wireText(event: ProducerWireEvent): string | undefined {
  return event.type === 'text' ? event.text : undefined
}

function recorder() {
  const log: Array<[string, unknown]> = []
  const cb: ChatStreamCallbacks = {
    onTurnId: (id) => log.push(['turn', id]),
    onText: (t) => log.push(['text', t]),
    onReasoning: (t) => log.push(['reasoning', t]),
    onToolCall: (c) => log.push(['tool_call', c.toolName]),
    onToolResult: (r) => log.push(['tool_result', r.outcome?.ok]),
    onUsage: (u) => log.push(['usage', u.completionTokens]),
    onMetadata: (d) => log.push(['metadata', d.modelUsed]),
    onErrorEvent: (m) => log.push(['error', m]),
  }
  return { log, cb }
}

const TURN_LINES = [
  { type: 'turn', turnId: 't-1' },
  { kind: 'event', event: { type: 'reasoning', text: 'hmm ' } },
  { kind: 'event', event: { type: 'text', text: 'Hello' }, seq: 3 }, // replayed shape
  { kind: 'event', event: { type: 'tool_call', call: { toolCallId: 'c1', toolName: 'sandbox_create', args: {} } } },
  { kind: 'tool_result', toolCallId: 'c1', toolName: 'sandbox_create', label: 'sandbox_create', outcome: { ok: true, result: { sandboxId: 's' } } },
  { kind: 'event', event: { type: 'usage', usage: { promptTokens: 10, completionTokens: 20 } } },
  { type: 'metadata', data: { modelUsed: 'm-1' } },
  { seq: -1, type: 'turn_status', status: 'complete' },
]

describe('consumeChatStream', () => {
  it('keeps ProducerWireEvent discriminated by its type field', () => {
    expect(wireText({ type: 'text', text: 'hello' })).toBe('hello')
    expect(wireText({ type: 'done', data: {}, seq: 4 })).toBeUndefined()
  })

  it('normalizes live, replayed (seq), and route-level line shapes', async () => {
    const { log, cb } = recorder()
    const result = await consumeChatStream(ndjsonBody(TURN_LINES), cb)
    expect(result).toEqual({ turnId: 't-1', receivedContent: true, lastSeq: 3 })
    expect(log).toEqual([
      ['turn', 't-1'],
      ['reasoning', 'hmm '],
      ['text', 'Hello'],
      ['tool_call', 'sandbox_create'],
      ['tool_result', true],
      ['usage', 20],
      ['metadata', 'm-1'],
    ])
  })

  it('tolerates torn/garbled lines without dropping the stream', async () => {
    const { log, cb } = recorder()
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('{"kind":"event","event":{"type":"text","te')) // torn across chunks
        c.enqueue(enc.encode('xt":"ok"}}\nnot json at all\n'))
        c.close()
      },
    })
    await consumeChatStream(body, cb)
    expect(log).toEqual([['text', 'ok']])
  })

  it('surfaces loop error events via onErrorEvent', () => {
    const { log, cb } = recorder()
    dispatchChatStreamLine(JSON.stringify({ type: 'error', error: 'Chat loop failed', details: 'boom' }), cb)
    expect(log).toEqual([['error', 'boom']])
  })

  it('dispatches flattened notice events', () => {
    const notices: unknown[] = []
    const result = dispatchChatStreamLine(JSON.stringify({
      type: 'notice',
      id: 'warning-1',
      noticeKind: 'warning',
      text: 'FILE_DENIED: Outside workspace',
    }), { onNotice: (notice) => notices.push(notice) })

    expect(notices).toEqual([{
      id: 'warning-1',
      noticeKind: 'warning',
      text: 'FILE_DENIED: Outside workspace',
    }])
    expect(result.receivedContent).toBe(true)
  })

  it('dispatches error notices', () => {
    const notices: unknown[] = []
    dispatchChatStreamLine(JSON.stringify({
      type: 'notice',
      id: 'error-1',
      noticeKind: 'error',
      text: 'The sandbox agent returned an error.',
    }), { onNotice: (notice) => notices.push(notice) })

    expect(notices).toEqual([{ id: 'error-1', noticeKind: 'error', text: 'The sandbox agent returned an error.' }])
  })

  it('dispatches structured error detail alongside the legacy message callback', () => {
    const messages: string[] = []
    const details: unknown[] = []
    dispatchChatStreamLine(JSON.stringify({
      type: 'error',
      data: {
        message: 'Please retry',
        code: 'sandbox.stream_failed',
        details: { failureNote: 'sandbox-stream: reset' },
      },
    }), {
      onErrorEvent: (message) => messages.push(message),
      onErrorEventDetail: (detail) => details.push(detail),
    })

    expect(messages).toEqual(['Please retry'])
    expect(details).toEqual([{
      message: 'Please retry',
      code: 'sandbox.stream_failed',
      details: { failureNote: 'sandbox-stream: reset' },
    }])
  })

  it('keeps the legacy error callback path unchanged without a detail callback', () => {
    const messages: string[] = []
    dispatchChatStreamLine(JSON.stringify({ type: 'error', data: { message: 'legacy path' } }), {
      onErrorEvent: (message) => messages.push(message),
    })
    expect(messages).toEqual(['legacy path'])
  })

  it('fails loud when no onErrorEvent is wired: the error lands in the transcript and console.error', () => {
    const texts: string[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = dispatchChatStreamLine(
        JSON.stringify({ type: 'error', error: 'Chat loop failed', details: 'boom' }),
        { onText: (t) => texts.push(t) },
      )
      // The turn must not end as a silent empty answer: the message reaches the
      // text channel (a text segment ChatMessages renders) and counts as content.
      expect(r.receivedContent).toBe(true)
      expect(texts.join('')).toContain('boom')
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(String(errorSpy.mock.calls[0]?.[1])).toContain('boom')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('an error with no callbacks at all still console.errors (never vanishes)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      dispatchChatStreamLine(JSON.stringify({ type: 'error', error: 'boom' }), {})
      expect(errorSpy).toHaveBeenCalledTimes(1)
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('streamChatTurn', () => {
  it('resumes once via the turnId after a transport drop, resetting first', async () => {
    const { log, cb } = recorder()
    let didReset = false
    const result = await streamChatTurn({
      // Live lines carry no seq, so the drop replays from 0.
      start: async () => new Response(ndjsonBody(TURN_LINES.slice(0, 2), { failAfter: 2 })),
      resume: async (turnId, fromSeq) => {
        expect(turnId).toBe('t-1')
        expect(fromSeq).toBe(0)
        return new Response(ndjsonBody(TURN_LINES))
      },
      onResetForResume: () => {
        didReset = true
        log.length = 0
      },
      reconnectDelayMs: () => 0,
      callbacks: cb,
    })
    expect(didReset).toBe(true)
    expect(result.turnId).toBe('t-1')
    expect(log.filter(([k]) => k === 'text')).toEqual([['text', 'Hello']])
  })

  it('resumes from the response header when the body drops before its marker', async () => {
    const { log, cb } = recorder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('network reset'))
      },
    })
    let didReset = false
    const result = await streamChatTurn({
      start: async () => new Response(body, { headers: { 'x-turn-id': 't-1' } }),
      resume: async (turnId, fromSeq) => {
        expect(turnId).toBe('t-1')
        expect(fromSeq).toBe(0)
        return new Response(ndjsonBody(TURN_LINES))
      },
      onResetForResume: () => {
        didReset = true
        log.length = 0
      },
      reconnectDelayMs: () => 0,
      callbacks: cb,
    })
    expect(didReset).toBe(true)
    expect(result.turnId).toBe('t-1')
    expect(log.filter(([k]) => k === 'text')).toEqual([['text', 'Hello']])
  })

  it.each([
    [400, { error: 'message is required' }, 'message is required', undefined],
    [409, { error: { code: 'workspace_turn_in_flight', message: 'A turn is still running' } }, 'A turn is still running', 'workspace_turn_in_flight'],
  ])('throws on a failed start response (%i) with the server error message and code', async (status, body, message, code) => {
    await expect(
      streamChatTurn({ start: async () => Response.json(body, { status }), callbacks: {} }),
    ).rejects.toMatchObject({ message, code })
  })

  it('resumes from the last stamped seq on a second drop, without resetting or duplicating', async () => {
    const { log, cb } = recorder()
    const resets: number[] = []
    const resumes: Array<{ turnId: string; fromSeq: number }> = []
    const result = await streamChatTurn({
      start: async () => new Response(ndjsonBody([
        { type: 'turn', turnId: 't-1' },
        { kind: 'event', event: { type: 'text', text: 'Hello ' } },
      ], { failAfter: 2 })),
      resume: async (turnId, fromSeq) => {
        resumes.push({ turnId, fromSeq })
        return fromSeq === 0
          ? new Response(ndjsonBody([
              { kind: 'event', event: { type: 'text', text: 'Hello ' }, seq: 3 },
              { kind: 'event', event: { type: 'text', text: 'world' }, seq: 4 },
            ], { failAfter: 2 }))
          : new Response(ndjsonBody([
              { kind: 'event', event: { type: 'text', text: '!' }, seq: 5 },
              { seq: -1, type: 'turn_status', status: 'complete' },
            ]))
      },
      onResetForResume: () => {
        resets.push(resumes.length)
        log.length = 0
      },
      reconnectDelayMs: () => 0,
      callbacks: cb,
    })
    expect(resumes).toEqual([{ turnId: 't-1', fromSeq: 0 }, { turnId: 't-1', fromSeq: 4 }])
    expect(resets).toEqual([0])
    expect(result.turnId).toBe('t-1')
    expect(result.lastSeq).toBe(5)
    expect(log.filter(([k]) => k === 'text')).toEqual([['text', 'Hello '], ['text', 'world'], ['text', '!']])
  })

  it('ends in the transport error after the reconnect budget is spent', async () => {
    const resumes: number[] = []
    const delays: number[] = []
    await expect(
      streamChatTurn({
        start: async () => new Response(ndjsonBody([{ type: 'turn', turnId: 't-1' }], { failAfter: 1 })),
        resume: async () => {
          resumes.push(1)
          return new Response('no stream', { status: 502 })
        },
        reconnectDelayMs: (attempt) => {
          delays.push(attempt)
          return 0
        },
        maxReconnects: 2,
        callbacks: {},
      }),
    ).rejects.toThrow('network reset')
    expect(resumes).toHaveLength(2)
    expect(delays).toEqual([0, 1])
  })

  it('keeps reasoning and its start time across a tail resume', async () => {
    const states: ChatReasoningState[] = []
    const cb: ChatStreamCallbacks = { onReasoningState: (s) => states.push({ ...s }) }
    const resumes: number[] = []
    await streamChatTurn({
      start: async () => new Response(ndjsonBody([
        { type: 'turn', turnId: 't-1' },
        { kind: 'event', event: { type: 'reasoning', text: 'part one ' } },
      ], { failAfter: 2 })),
      resume: async (_turnId, fromSeq) => {
        resumes.push(fromSeq)
        return fromSeq === 0
          ? new Response(ndjsonBody([
              { kind: 'event', event: { type: 'reasoning', text: 'part one ' }, seq: 2 },
            ], { failAfter: 1 }))
          : new Response(ndjsonBody([
              { kind: 'event', event: { type: 'reasoning', text: 'part two' }, seq: 3 },
              { seq: -1, type: 'turn_status', status: 'complete' },
            ]))
      },
      reconnectDelayMs: () => 0,
      callbacks: cb,
    })
    expect(resumes).toEqual([0, 2])
    const last = states[states.length - 1]!
    expect(last.text).toBe('part one part two')
    expect(last.thinking).toBe(false)
    expect(last.startedAt).toBe(states[0]!.startedAt)
  })

  it('grows the default reconnect delay exponentially, jittered, and caps it', () => {
    expect(defaultReconnectDelayMs(0, () => 0)).toBe(250)
    expect(defaultReconnectDelayMs(0, () => 1)).toBe(750)
    expect(defaultReconnectDelayMs(2, () => 1)).toBe(3000)
    expect(defaultReconnectDelayMs(4, () => 1)).toBe(8000)
    expect(defaultReconnectDelayMs(10, () => 1)).toBe(8000)
  })
})
