import { describe, it, expect } from 'vitest'
import {
  finalizeAssistantParts,
  getPartKey,
  mergePersistedPart,
  normalizePersistedPart,
  type JsonRecord,
} from '../src/stream/stream-normalizer'

function buildParts(entries: JsonRecord[]): { order: string[]; map: Map<string, JsonRecord> } {
  const order: string[] = []
  const map = new Map<string, JsonRecord>()
  for (const entry of entries) {
    const key = getPartKey(entry)
    if (!map.has(key)) order.push(key)
    map.set(key, mergePersistedPart(map.get(key), entry))
  }
  return { order, map }
}

describe('normalizePersistedPart', () => {
  it('preserves id on text and reasoning parts', () => {
    expect(normalizePersistedPart({ type: 'text', id: 'txt_1', text: 'hello' })).toEqual({
      type: 'text',
      id: 'txt_1',
      text: 'hello',
    })
    expect(normalizePersistedPart({ type: 'reasoning', id: 'rsn_1', text: 'hmm' })).toMatchObject({
      type: 'reasoning',
      id: 'rsn_1',
      text: 'hmm',
    })
  })

  it('falls back to partId and never invents an id', () => {
    expect(normalizePersistedPart({ type: 'text', partId: 'p_9', text: 'x' })).toMatchObject({ id: 'p_9' })
    const bare = normalizePersistedPart({ type: 'text', text: 'x' })
    expect(bare).toEqual({ type: 'text', text: 'x' })
    expect(bare && 'id' in bare).toBe(false)
  })
})

describe('getPartKey', () => {
  it('keys text/reasoning per id and collapses id-less parts to current', () => {
    expect(getPartKey({ type: 'text', id: 't1' })).toBe('text:t1')
    expect(getPartKey({ type: 'reasoning', id: 'r1' })).toBe('reasoning:r1')
    expect(getPartKey({ type: 'text' })).toBe('text:current')
    expect(getPartKey({ type: 'reasoning' })).toBe('reasoning:current')
  })
})

describe('mergePersistedPart', () => {
  it('keeps distinct ids as distinct map entries and merges within one id', () => {
    const { order, map } = buildParts([
      { type: 'reasoning', id: 'r1', text: 'first' },
      { type: 'reasoning', id: 'r2', text: 'second' },
      { type: 'reasoning', id: 'r2', text: 'second updated' },
    ])
    expect(order).toEqual(['reasoning:r1', 'reasoning:r2'])
    expect(map.get('reasoning:r1')?.text).toBe('first')
    expect(map.get('reasoning:r2')?.text).toBe('second updated')
  })

  it('appends deltas within the same id and keeps existing id on bare deltas', () => {
    const first = normalizePersistedPart({ type: 'text', id: 't1', text: 'Hel' })!
    const merged = mergePersistedPart(first, normalizePersistedPart({ type: 'text', id: 't1', text: '' })!, 'lo')
    expect(merged).toMatchObject({ type: 'text', id: 't1' })
    expect(merged.text).toBe('Hello')
  })

  it('replaces text on same-id snapshots (no delta)', () => {
    const first = normalizePersistedPart({ type: 'text', id: 't1', text: 'Hel' })!
    const merged = mergePersistedPart(first, normalizePersistedPart({ type: 'text', id: 't1', text: 'Hello world' })!)
    expect(merged.text).toBe('Hello world')
  })

  it('keeps accumulated text when a snapshot arrives empty', () => {
    const first = normalizePersistedPart({ type: 'text', id: 't1', text: 'Hello' })!
    const merged = mergePersistedPart(first, normalizePersistedPart({ type: 'text', id: 't1', text: '' })!)
    expect(merged.text).toBe('Hello')
  })
})

describe('finalizeAssistantParts', () => {
  it('appends finalText when no text part exists and skips blank finalText', () => {
    const { order, map } = buildParts([{ type: 'reasoning', id: 'r1', text: 'thinking' }])
    expect(finalizeAssistantParts(order, map, 'answer')).toEqual([
      { type: 'reasoning', id: 'r1', text: 'thinking', time: undefined },
      { type: 'text', text: 'answer' },
    ])
    expect(finalizeAssistantParts(order, map, '   ')).toHaveLength(1)
  })

  it('overwrites id-less text parts with finalText (legacy single-stream)', () => {
    const { order, map } = buildParts([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'partial' },
    ])
    const finalized = finalizeAssistantParts(order, map, 'the full answer')
    expect(finalized).toEqual([
      { type: 'reasoning', text: 'thinking', time: undefined },
      { type: 'text', text: 'the full answer' },
    ])
  })

  it('leaves per-id text segments untouched when their concatenation equals finalText', () => {
    const { order, map } = buildParts([
      { type: 'text', id: 't1', text: 'Hello ' },
      { type: 'tool', id: 'call_1', tool: 'search', status: 'completed', output: 'ok' },
      { type: 'text', id: 't2', text: 'world' },
    ])
    const finalized = finalizeAssistantParts(order, map, 'Hello world')
    expect(finalized.map((p) => p.type)).toEqual(['text', 'tool', 'text'])
    expect(finalized[0].text).toBe('Hello ')
    expect(finalized[2].text).toBe('world')
  })

  it('treats trailing-whitespace differences as equal', () => {
    const { order, map } = buildParts([{ type: 'text', id: 't1', text: 'answer\n' }])
    expect(finalizeAssistantParts(order, map, 'answer')).toEqual([{ type: 'text', id: 't1', text: 'answer\n' }])
  })

  it('appends the remainder as an id-less segment when finalText extends the stream', () => {
    const { order, map } = buildParts([
      { type: 'text', id: 't1', text: 'answer' },
    ])
    const finalized = finalizeAssistantParts(order, map, 'answer\n\n---\nstream failed')
    expect(finalized).toEqual([
      { type: 'text', id: 't1', text: 'answer' },
      { type: 'text', text: '\n\n---\nstream failed' },
    ])
  })

  it('collapses text to one authoritative segment at the last text position on divergence', () => {
    const { order, map } = buildParts([
      { type: 'reasoning', id: 'r1', text: 'thinking' },
      { type: 'text', id: 't1', text: 'draft one' },
      { type: 'tool', id: 'call_1', tool: 'search', status: 'completed', output: 'ok' },
      { type: 'text', id: 't2', text: 'draft two' },
    ])
    const finalized = finalizeAssistantParts(order, map, 'a corrected final answer')
    expect(finalized.map((p) => [p.type, p.id])).toEqual([
      ['reasoning', 'r1'],
      ['tool', 'call_1'],
      ['text', 't2'],
    ])
    expect(finalized[2].text).toBe('a corrected final answer')
  })

  it('preserves interleaved order end to end', () => {
    const { order, map } = buildParts([
      { type: 'reasoning', id: 'r1', text: 'plan' },
      { type: 'tool', id: 'call_1', tool: 'search', status: 'completed', output: 'ok' },
      { type: 'reasoning', id: 'r2', text: 'revise' },
      { type: 'text', id: 't1', text: 'done' },
    ])
    const finalized = finalizeAssistantParts(order, map, 'done')
    expect(finalized.map((p) => [p.type, p.id])).toEqual([
      ['reasoning', 'r1'],
      ['tool', 'call_1'],
      ['reasoning', 'r2'],
      ['text', 't1'],
    ])
  })
})
