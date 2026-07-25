import { describe, expect, it } from 'vitest'
import { createSandboxChatProducer } from '../../src/chat-routes/sandbox-producer'

/**
 * Lane portability of `createSandboxChatProducer`.
 *
 * A sandbox turn reaches the shell over one of two platform lanes, and they do
 * NOT share text semantics:
 *
 * - run/stream (`POST /agents/run/stream`) carries an explicit `delta`.
 * - the message lane (`POST /agents/sessions/{id}/messages`) is SNAPSHOT-only:
 *   every `message.part.updated` re-sends the whole accumulated part text.
 *
 * Appending a snapshot as if it were a delta inflates the transcript
 * quadratically (measured 3.133x at five updates when the reconciliation in
 * `textDelta` is removed), and the inflation reaches the DURABLE row whenever
 * the turn is persisted before the terminal `result` receipt arrives — which
 * is exactly what incremental draft persistence (#250) does.
 *
 * These probes pin BOTH the streamed bytes and the persisted projection to
 * 1.000x across every lane shape, so the producer stays safe to point at
 * either lane. They fail loudly if the reconciliation regresses.
 */
const TRUE_TEXT = 'alpha bravo charlie delta echo'
const CHUNKS = ['alpha ', 'bravo ', 'charlie ', 'delta ', 'echo']

/** Message-lane shape: each event re-sends the whole accumulated text. */
function snapshots(partId?: string): unknown[] {
  const out: unknown[] = []
  let acc = ''
  for (const chunk of CHUNKS) {
    acc += chunk
    out.push({
      type: 'message.part.updated',
      data: { part: { ...(partId ? { id: partId } : {}), type: 'text', text: acc } },
    })
  }
  return out
}

/** run/stream shape: each event carries only the new suffix. */
function deltas(partId?: string): unknown[] {
  return CHUNKS.map((chunk) => ({
    type: 'message.part.updated',
    data: { part: { ...(partId ? { id: partId } : {}), type: 'text', text: chunk }, delta: chunk },
  }))
}

async function run(events: unknown[]): Promise<{ streamed: string; persisted: string }> {
  async function* generate(): AsyncGenerator<unknown> {
    for (const event of events) yield event
  }
  const producer = createSandboxChatProducer({ events: generate() })
  let streamed = ''
  for await (const event of producer.stream) {
    const wire = event as { type?: string; text?: string }
    if (wire.type === 'text' && typeof wire.text === 'string') streamed += wire.text
  }
  const parts = (producer.assistantParts?.() ?? []) as Array<{ type?: string; text?: string }>
  const persisted = parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
  return { streamed, persisted }
}

const RESULT = { type: 'result', data: { finalText: TRUE_TEXT } }

describe('createSandboxChatProducer is lane-portable', () => {
  const cases: Array<[string, unknown[]]> = [
    ['run/stream: deltas, stable part id', deltas('prt_1')],
    ['run/stream: deltas, no part id', deltas()],
    ['message lane: snapshots, stable part id', snapshots('prt_1')],
    ['message lane: snapshots, no part id', snapshots()],
    ['message lane: snapshots + terminal result receipt', [...snapshots('prt_1'), RESULT]],
    [
      'message lane: snapshots + whole-message echo + receipt',
      [
        ...snapshots('prt_1'),
        {
          type: 'message.updated',
          data: { message: { parts: [{ id: 'prt_1', type: 'text', text: TRUE_TEXT }] } },
        },
        RESULT,
      ],
    ],
    [
      'message lane: transcript split across two part ids',
      [
        { type: 'message.part.updated', data: { part: { id: 'p1', type: 'text', text: TRUE_TEXT.slice(0, 12) } } },
        { type: 'message.part.updated', data: { part: { id: 'p2', type: 'text', text: TRUE_TEXT.slice(12) } } },
        RESULT,
      ],
    ],
  ]

  for (const [name, events] of cases) {
    it(`${name} -> 1.000x streamed and persisted`, async () => {
      const { streamed, persisted } = await run(events)
      expect(streamed).toBe(TRUE_TEXT)
      expect(persisted).toBe(TRUE_TEXT)
    })
  }

  it('a mid-stream draft is already correct, without waiting for the receipt', async () => {
    // The receipt rescues the persisted row at finalize; incremental
    // persistence writes BEFORE it, so the pre-receipt projection must
    // already be right on its own.
    const withReceipt = await run([...snapshots('prt_1'), RESULT])
    const withoutReceipt = await run(snapshots('prt_1'))
    expect(withoutReceipt.persisted).toBe(withReceipt.persisted)
    expect(withoutReceipt.persisted).toBe(TRUE_TEXT)
  })
})
