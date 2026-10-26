import { describe, expect, it } from 'vitest'
import { segmentsFromParts, toolCallsFromParts } from './message-projection'

describe('message projection from stored parts', () => {
  const parts = [
    { type: 'reasoning', text: 'think' },
    { type: 'text', text: 'Looking' },
    { type: 'text', text: ' it up.' },
    { type: 'tool', id: 'p1', callID: 'call_1', tool: 'search', state: { status: 'completed', input: { q: 'risks' }, output: { hits: 3 } } },
    { type: 'notice', id: 'n1', noticeKind: 'warning', text: 'Rate limited once.' },
    { type: 'tool', id: 'p2', tool: 'write', state: { status: 'error', error: 'denied' } },
    { type: 'text', text: 'Three risks.' },
  ]

  it('interleaves folded text runs, tool cards and notices in stored order', () => {
    expect(segmentsFromParts(parts)).toEqual([
      { kind: 'text', content: 'Looking it up.' },
      { kind: 'tool', call: { id: 'call_1', name: 'search', status: 'done', args: { q: 'risks' }, result: { hits: 3 } } },
      { kind: 'notice', tone: 'warning', content: 'Rate limited once.' },
      { kind: 'tool', call: { id: 'p2', name: 'write', status: 'error' } },
      { kind: 'text', content: 'Three risks.' },
    ])
    expect(toolCallsFromParts(parts).map((call) => call.name)).toEqual(['search', 'write'])
  })

  it('returns no segments for a plain text message, so the body renders as prose', () => {
    expect(segmentsFromParts([{ type: 'text', text: 'Hello' }, { type: 'reasoning', text: 'x' }])).toEqual([])
    expect(segmentsFromParts(null)).toEqual([])
  })
})
