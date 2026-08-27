import { describe, expect, it } from 'vitest'

import { toChatMessageParts, type ChatMessagePart } from '../../src/chat-store/parts'

describe('toChatMessageParts — the /stream → /chat-store typed boundary', () => {
  it('accepts every storable kind (nothing storable falls out)', () => {
    const oneOfEach: Array<Record<string, unknown>> = [
      { type: 'text', text: 'hello', id: 't1' },
      { type: 'reasoning', text: 'hmm' },
      { type: 'tool', id: 'c1', tool: 'search', state: { status: 'completed', output: 'x' } },
      { type: 'file', filename: 'a.csv', path: 'out/a.csv' },
      { type: 'image', url: 'data:image/png;base64,AA' },
      { type: 'subtask', prompt: 'p', description: 'd', agent: 'a' },
      { type: 'step-start' },
      { type: 'step-finish', tokens: { input: 5, output: 2 }, cost: 0.01 },
      { type: 'interaction', id: 'i1', kind: 'question', title: 'T', answerSpec: { fields: [] }, status: 'pending' },
      { type: 'notice', id: 'n1', noticeKind: 'warning', text: 'heads up' },
      {
        type: 'plan', planId: 'p1', revision: 1, body: 'Plan',
        submittedAt: '2026-07-21T00:00:00.000Z', status: 'pending',
      },
      { type: 'mention', mentionKind: 'file', path: 'docs/a.md', name: 'a.md' },
    ]
    const typed: ChatMessagePart[] = toChatMessageParts(oneOfEach)
    expect(typed.map((part) => part.type)).toEqual(oneOfEach.map((part) => part.type))
  })

  it('drops junk: unknown kinds, missing required fields, non-objects', () => {
    expect(toChatMessageParts([
      { type: 'telemetry', blob: 1 },
      { type: 'text' }, // no text
      { type: 'tool', id: 'c1' }, // no tool/state
      { type: 'notice', id: 'n1' }, // no noticeKind/text
      { type: 'mention', path: 'a.md', name: 'a.md' }, // no mentionKind
      {
        type: 'plan', planId: 'p1', revision: 0, body: 'Plan',
        submittedAt: '2026-07-21T00:00:00.000Z', status: 'pending',
      },
      {
        type: 'interaction', id: 'i1', kind: 'question', title: 'T',
        answerSpec: { fields: [] }, status: 'answered', answers: { q0: { nested: 'invalid' } },
      },
      { noType: true },
    ])).toEqual([])
  })

  it('preserves extra fields the row round-trips (e.g. turnId on a user text part)', () => {
    const [part] = toChatMessageParts([{ type: 'text', text: 'q', turnId: 'turn-1' }])
    expect(part).toEqual({ type: 'text', text: 'q', turnId: 'turn-1' })
  })
})
