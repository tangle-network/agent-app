import { describe, it, expect } from 'vitest'
import {
  dispatchChatStreamLine,
  consumeChatStream,
  type ChatStreamCallbacks,
} from './chat-stream'
import type { ChatInteraction } from './chat-interactions'

// A well-formed sidecar `interaction` ask: a `question` with one text field.
// Matches the wire shape the sidecar emits and a real chat consumer already
// parses — `{type:'interaction', data:{request}}`.
function questionRequest() {
  return {
    id: 'ask-1',
    kind: 'question',
    title: 'Which segment should we target first?',
    body: 'Pick the primary ICP.',
    answerSpec: {
      fields: [{ type: 'text', name: 'answer', label: 'Your answer' }],
    },
  }
}

function interactionLine(): string {
  return JSON.stringify({ type: 'interaction', data: { request: questionRequest() } })
}

function readableFromLines(lines: string[]): ReadableStream<Uint8Array> {
  const body = lines.join('\n') + '\n'
  const bytes = new TextEncoder().encode(body)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

describe('dispatchChatStreamLine — interaction', () => {
  it('surfaces the sidecar interaction line as a pending ChatInteraction', () => {
    const seen: ChatInteraction[] = []
    const result = dispatchChatStreamLine(interactionLine(), {
      onInteraction: (interaction) => seen.push(interaction),
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({
      id: 'ask-1',
      kind: 'question',
      title: 'Which segment should we target first?',
      body: 'Pick the primary ICP.',
      fields: [{ type: 'text', name: 'answer', label: 'Your answer' }],
      status: 'pending',
    })
    // A blocked-on-user ask is real turn activity.
    expect(result.receivedContent).toBe(true)
  })

  it('also recognizes the interaction inside a {kind:"event"} envelope', () => {
    const seen: ChatInteraction[] = []
    const line = JSON.stringify({ kind: 'event', event: { type: 'interaction', data: { request: questionRequest() } } })
    dispatchChatStreamLine(line, { onInteraction: (i) => seen.push(i) })

    expect(seen).toHaveLength(1)
    expect(seen[0]!.id).toBe('ask-1')
    expect(seen[0]!.status).toBe('pending')
  })

  it('is non-breaking: a consumer with NO onInteraction parses the same line unchanged', () => {
    // No onInteraction wired, and the OTHER callbacks still behave. The
    // interaction line must not throw and must not corrupt the parse.
    const texts: string[] = []
    const cb: ChatStreamCallbacks = { onText: (t) => texts.push(t) }

    expect(() => dispatchChatStreamLine(interactionLine(), cb)).not.toThrow()
    const textResult = dispatchChatStreamLine(
      JSON.stringify({ type: 'text', text: 'hello' }),
      cb,
    )
    expect(texts).toEqual(['hello'])
    expect(textResult.receivedContent).toBe(true)
  })

  it('drops a malformed interaction line (no request) without firing onInteraction', () => {
    let fired = false
    const result = dispatchChatStreamLine(
      JSON.stringify({ type: 'interaction', data: {} }),
      { onInteraction: () => { fired = true } },
    )
    expect(fired).toBe(false)
    expect(result.receivedContent).toBe(false)
  })
})

describe('consumeChatStream — interaction', () => {
  it('fires onInteraction while draining an NDJSON body', async () => {
    const seen: ChatInteraction[] = []
    const texts: string[] = []
    const body = readableFromLines([
      JSON.stringify({ type: 'turn', turnId: 'turn-9' }),
      interactionLine(),
      JSON.stringify({ type: 'text', text: 'done' }),
    ])

    const result = await consumeChatStream(body, {
      onInteraction: (i) => seen.push(i),
      onText: (t) => texts.push(t),
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]!.id).toBe('ask-1')
    expect(texts).toEqual(['done'])
    expect(result.turnId).toBe('turn-9')
    expect(result.receivedContent).toBe(true)
  })
})
