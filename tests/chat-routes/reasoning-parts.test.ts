/**
 * One reasoning shape from both chat producers to the browser: the engine
 * (`createRouterTurnProducer`) and the sandbox (`createSandboxChatProducer`)
 * stream `{ type: 'reasoning', text }` deltas and persist each reasoning run as
 * `{ type: 'reasoning', text, time: { start, end } }`; `/web-react`'s chat
 * stream keeps the live state (`onReasoningState`) and reads the saved parts
 * back (`chatReasoningFromParts`) as the same `ChatReasoningState`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createRouterTurnProducer, createSandboxChatProducer } from '../../src/chat-routes/index'
import {
  chatReasoningFromParts,
  consumeChatStream,
  streamChatTurn,
  trackChatReasoning,
  type ChatReasoningState,
} from '../../src/web-react/chat-stream'

/** A wall clock that moves one second per reading, so every start and end is distinct and ordered. */
function steppingClock(from = 1_000_000) {
  let now = from
  return vi.spyOn(Date, 'now').mockImplementation(() => (now += 1_000))
}

afterEach(() => vi.restoreAllMocks())

function sse(chunks: unknown[]) {
  const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const reasoning = (value: string) => ({ choices: [{ delta: { reasoning_content: value } }] })
const text = (value: string) => ({ choices: [{ delta: { content: value } }] })
const toolCall = (id: string, name: string) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })

function router(...responses: Response[]) {
  return (async () => {
    const next = responses.shift()
    if (!next) throw new Error('unexpected model call')
    return next
  }) as unknown as typeof fetch
}

function ndjson(events: unknown[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(events.map(event => JSON.stringify(event)).join('\n') + '\n')
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } })
}

/** A body that delivers `events`, then drops the connection. */
function droppingNdjson(events: unknown[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(events.map(event => JSON.stringify(event)).join('\n') + '\n')
  let sent = false
  return new ReadableStream({
    pull(controller) {
      if (sent) controller.error(new Error('network reset'))
      else { controller.enqueue(bytes); sent = true }
    },
  })
}

async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const event of stream) out.push(event)
  return out
}

type Time = { start: number; end: number }

describe('reasoning parts', () => {
  it('the engine persists each reasoning run with its start and end, ended by the tool and by the answer', async () => {
    steppingClock()
    const lookup = { name: 'rooms.ready', description: 'Count ready rooms.', inputSchema: { type: 'object', properties: {} }, run: async () => ({ ready: 4 }) }
    const producer = createRouterTurnProducer({ apiKey: 'k', model: 'm', systemPrompt: 's', userMessage: 'How many rooms?', tools: [lookup],
      fetchImpl: router(
        sse([reasoning('Need the '), reasoning('count.'), toolCall('call-1', 'rooms_ready')]),
        sse([reasoning('Four are ready.'), text('Four rooms are ready.')]),
      ) })
    const wire = await drain(producer.stream)
    expect(wire.filter(event => event.type === 'reasoning')).toEqual([
      { type: 'reasoning', text: 'Need the ' }, { type: 'reasoning', text: 'count.' }, { type: 'reasoning', text: 'Four are ready.' },
    ])

    const parts = producer.assistantParts!()
    const [first, tool, second] = parts as Array<{ type: string; text?: string; time?: Time; state?: { time: Time } }>
    expect(first).toEqual({ type: 'reasoning', text: 'Need the count.', time: { start: expect.any(Number), end: expect.any(Number) } })
    expect(second).toEqual({ type: 'reasoning', text: 'Four are ready.', time: { start: expect.any(Number), end: expect.any(Number) } })
    // The first run ends no later than the tool starts; the second starts after the tool and ends before the turn does.
    expect(first!.time!.start).toBeLessThan(first!.time!.end)
    expect(first!.time!.end).toBeLessThanOrEqual(tool!.state!.time.start)
    expect(second!.time!.start).toBeGreaterThanOrEqual(tool!.state!.time.end)
    expect(second!.time!.start).toBeLessThan(second!.time!.end)

    // A reload reads the saved parts back as one settled reasoning state spanning both runs.
    expect(chatReasoningFromParts(parts)).toEqual({
      text: 'Need the count.\n\nFour are ready.', startedAt: first!.time!.start, endedAt: second!.time!.end, thinking: false,
    })
  })

  it('the sandbox persists the same shape: the clock fills a harness part that has no time, and keeps one that does', async () => {
    steppingClock()
    const part = (p: Record<string, unknown>, delta?: string) => ({ type: 'message.part.updated', data: { part: p, ...(delta ? { delta } : {}) } })
    const producer = createSandboxChatProducer({
      events: (async function* () {
        yield part({ type: 'reasoning', id: 'r1', text: 'Need the' }, 'Need the')
        yield part({ type: 'reasoning', id: 'r1', text: 'Need the count.' }, ' count.')
        yield part({ type: 'tool', id: 't1', callID: 't1', tool: 'rooms', state: { status: 'completed', input: {}, output: 4 } })
        yield part({ type: 'reasoning', id: 'r2', text: 'Timed by the harness.', time: { start: 5, end: 9 } }, 'Timed by the harness.')
        yield part({ type: 'text', id: 'x1', text: 'Four.' }, 'Four.')
        yield { type: 'result', data: { finalText: 'Four.' } }
      })(),
    })
    const wire = await drain(producer.stream)
    expect(wire.filter(event => event.type === 'reasoning')).toEqual([
      { type: 'reasoning', text: 'Need the' }, { type: 'reasoning', text: ' count.' }, { type: 'reasoning', text: 'Timed by the harness.' },
    ])
    const reasoningParts = producer.assistantParts!().filter(p => p.type === 'reasoning') as Array<{ text: string; time: Time }>
    expect(reasoningParts[0]).toMatchObject({ text: 'Need the count.', time: { start: expect.any(Number), end: expect.any(Number) } })
    expect(reasoningParts[0]!.time.start).toBeLessThan(reasoningParts[0]!.time.end)
    expect(reasoningParts[1]).toMatchObject({ text: 'Timed by the harness.', time: { start: 5, end: 9 } })
  })

  it('the client keeps one reasoning state: starts on the first delta, joins a run after a tool, ends on the answer', async () => {
    steppingClock()
    const states: ChatReasoningState[] = []
    const order: string[] = []
    await consumeChatStream(ndjson([
      { kind: 'event', event: { type: 'reasoning', text: 'Need the ' } },
      { kind: 'event', event: { type: 'reasoning', text: 'count.' } },
      { kind: 'event', event: { type: 'tool_call', call: { toolCallId: 'c1', toolName: 'rooms', args: {} } } },
      { kind: 'event', event: { type: 'reasoning', text: 'Four are ready.' } },
      { kind: 'event', event: { type: 'text', text: 'Four ' } },
      { kind: 'event', event: { type: 'text', text: 'rooms.' } },
    ]), {
      onReasoningState: (state) => { states.push(state); order.push(state.thinking ? 'thinking' : 'ended') },
      onText: (delta) => order.push(`text:${delta}`),
    })
    // Thinking ends the moment the answer's first word arrives, not when the stream closes.
    expect(order.slice(-3)).toEqual(['ended', 'text:Four ', 'text:rooms.'])
    const startedAt = states[0]!.startedAt!
    expect(states.map(state => [state.text, state.thinking])).toEqual([
      ['Need the ', true],
      ['Need the count.', true],
      ['Need the count.\n\nFour are ready.', true],
      ['Need the count.\n\nFour are ready.', false],
    ])
    expect(states.every(state => state.startedAt === startedAt)).toBe(true)
    expect(states.slice(0, 3).every(state => state.endedAt === undefined)).toBe(true)
    expect(states[3]!.endedAt).toBeGreaterThan(startedAt)
  })

  it('ends thinking when the stream closes or fails without an answer, and never fires for a turn without reasoning', async () => {
    steppingClock()
    const closed: ChatReasoningState[] = []
    await consumeChatStream(ndjson([{ kind: 'event', event: { type: 'reasoning', text: 'Hmm.' } }]), { onReasoningState: state => closed.push(state) })
    expect(closed.at(-1)).toMatchObject({ text: 'Hmm.', thinking: false, endedAt: expect.any(Number) })

    const failed: ChatReasoningState[] = []
    const tracked = trackChatReasoning({ onReasoningState: state => failed.push(state), onErrorEvent: () => {} })
    tracked.onReasoning!('Checking.')
    tracked.onErrorEventDetail!({ message: 'model down' })
    expect(failed.at(-1)).toMatchObject({ thinking: false, endedAt: expect.any(Number) })

    const none: ChatReasoningState[] = []
    await consumeChatStream(ndjson([{ kind: 'event', event: { type: 'text', text: 'Hi.' } }]), { onReasoningState: state => none.push(state) })
    expect(none).toEqual([])
  })

  it('keeps one reasoning state across a resume: the replay neither repeats the reasoning nor restarts its clock', async () => {
    steppingClock()
    const turn = [
      { type: 'turn', turnId: 't-1' },
      { kind: 'event', event: { type: 'reasoning', text: 'Need the ' } },
      { kind: 'event', event: { type: 'reasoning', text: 'count.' } },
    ]
    const states: ChatReasoningState[] = []
    await streamChatTurn({
      start: async () => new Response(droppingNdjson(turn)),
      // The resume route replays the whole turn from its first event, then the answer.
      resume: async () => new Response(ndjson([...turn, { kind: 'event', event: { type: 'text', text: 'Four.' } }])),
      callbacks: { onReasoningState: state => states.push(state) },
    })
    const first = states[0]!
    const last = states.at(-1)!
    expect(last.text).toBe('Need the count.')
    expect(last.thinking).toBe(false)
    expect(last.startedAt).toBe(first.startedAt)
    expect(states.every(state => state.startedAt === first.startedAt)).toBe(true)
  })

  it('settles thinking when the stream fails for good after reasoning', async () => {
    steppingClock()
    const states: ChatReasoningState[] = []
    await expect(consumeChatStream(droppingNdjson([{ kind: 'event', event: { type: 'reasoning', text: 'Checking.' } }]),
      { onReasoningState: state => states.push(state) })).rejects.toThrow('network reset')
    expect(states.at(-1)).toMatchObject({ text: 'Checking.', thinking: false, endedAt: expect.any(Number) })

    const turnStates: ChatReasoningState[] = []
    await expect(streamChatTurn({
      start: async () => new Response(droppingNdjson([{ kind: 'event', event: { type: 'reasoning', text: 'Checking.' } }])),
      callbacks: { onReasoningState: state => turnStates.push(state) },
    })).rejects.toThrow('network reset')
    expect(turnStates.at(-1)).toMatchObject({ thinking: false, endedAt: expect.any(Number) })
  })

  it('reads saved parts without times as settled reasoning with no duration, and no reasoning as none', () => {
    expect(chatReasoningFromParts([{ type: 'reasoning', text: 'Old.' }, { type: 'text', text: 'A.' }])).toEqual({ text: 'Old.', thinking: false })
    expect(chatReasoningFromParts([{ type: 'reasoning', text: '  ' }, { type: 'text', text: 'A.' }])).toBeUndefined()
    expect(chatReasoningFromParts(undefined)).toBeUndefined()
  })
})
