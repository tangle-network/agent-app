import { describe, it, expect, vi } from 'vitest'
import {
  consumeChatStream,
  dispatchChatStreamLine,
  streamChatTurn,
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
    expect(result).toEqual({ turnId: 't-1', receivedContent: true })
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
      start: async () => new Response(ndjsonBody(TURN_LINES.slice(0, 3), { failAfter: 3 })),
      resume: async (turnId, fromSeq) => {
        expect(turnId).toBe('t-1')
        expect(fromSeq).toBe(0)
        return new Response(ndjsonBody(TURN_LINES))
      },
      onResetForResume: () => {
        didReset = true
        log.length = 0
      },
      callbacks: cb,
    })
    expect(didReset).toBe(true)
    expect(result.turnId).toBe('t-1')
    expect(log.filter(([k]) => k === 'text')).toEqual([['text', 'Hello']])
  })

  it('throws on a failed start response with the server error message', async () => {
    await expect(
      streamChatTurn({
        start: async () => new Response(JSON.stringify({ error: 'message is required' }), { status: 400 }),
        callbacks: {},
      }),
    ).rejects.toThrow('message is required')
  })
})
