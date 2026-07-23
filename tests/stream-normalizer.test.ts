import { describe, it, expect } from 'vitest'
import {
  attachmentPartKey,
  collapseRedundantTextParts,
  finalizeAssistantParts,
  finalizePendingInteractionParts,
  getPartKey,
  MISSING_TOOL_TERMINAL_ERROR,
  MISSING_TOOL_TERMINAL_REASON,
  mergePersistedPart,
  normalizePersistedPart,
  terminalizeDanglingAssistantToolUpdates,
  terminalizeDanglingToolPart,
  terminalizeDanglingToolParts,
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

  it('normalizes failed tool statuses as terminal errors', () => {
    expect(
      normalizePersistedPart({
        type: 'tool',
        id: 'prt_x',
        tool: 'bash',
        callID: 'toolu_x',
        state: { status: 'failed', input: {} },
      }),
    ).toMatchObject({
      type: 'tool',
      id: 'prt_x',
      tool: 'bash',
      callID: 'toolu_x',
      state: { status: 'error', input: {}, error: undefined },
    })

    expect(
      normalizePersistedPart({
        type: 'tool',
        id: 'prt_y',
        tool: 'bash',
        callID: 'toolu_y',
        status: 'failed',
      }),
    ).toMatchObject({
      type: 'tool',
      id: 'prt_y',
      state: { status: 'error', input: undefined, error: undefined },
    })

    expect(
      normalizePersistedPart({
        type: 'tool',
        id: 'prt_z',
        tool: 'bash',
        callID: 'toolu_z',
        state: { status: 'failed', input: { command: 'exit 1' }, error: 'exit 1' },
      }),
    ).toMatchObject({
      state: {
        status: 'error',
        input: { command: 'exit 1' },
        error: 'exit 1',
      },
    })
  })
})

describe('getPartKey', () => {
  it('keys text/reasoning per id and collapses id-less parts to current', () => {
    expect(getPartKey({ type: 'text', id: 't1' })).toBe('text:t1')
    expect(getPartKey({ type: 'reasoning', id: 'r1' })).toBe('reasoning:r1')
    expect(getPartKey({ type: 'text' })).toBe('text:current')
    expect(getPartKey({ type: 'reasoning' })).toBe('reasoning:current')
  })

  it('keys other typed kinds in their own lane, never the text lane', () => {
    expect(getPartKey({ type: 'file', id: 'f1' })).toBe('file:f1')
    expect(getPartKey({ type: 'image' })).toBe('image:current')
    expect(getPartKey({ type: 'step-finish' })).toBe('step-finish:current')
    // Untyped legacy parts still fall back to the text lane.
    expect(getPartKey({})).toBe('text:current')
  })
})

describe('normalizePersistedPart — full storable vocabulary', () => {
  it('projects file and image parts (no silent drop)', () => {
    expect(normalizePersistedPart({
      type: 'file', id: 'f1', filename: 'a.csv', mediaType: 'text/csv', path: 'out/a.csv', sessionID: 's', messageID: 'm',
    })).toEqual({ type: 'file', id: 'f1', filename: 'a.csv', mediaType: 'text/csv', path: 'out/a.csv' })
    expect(normalizePersistedPart({ type: 'image', url: 'data:image/png;base64,AA', mediaType: 'image/png' }))
      .toEqual({ type: 'image', mediaType: 'image/png', url: 'data:image/png;base64,AA' })
  })

  it('keeps the step-finish usage receipt and step-start marker', () => {
    expect(normalizePersistedPart({
      type: 'step-finish', reason: 'stop', tokens: { input: 5, output: 2 }, cost: 0.01,
    })).toEqual({ type: 'step-finish', reason: 'stop', tokens: { input: 5, output: 2 }, cost: 0.01 })
    expect(normalizePersistedPart({ type: 'step-start', extra: 'stripped' })).toEqual({ type: 'step-start' })
  })

  it('projects subtask parts and passes system-authored interaction/notice parts through', () => {
    expect(normalizePersistedPart({ type: 'subtask', prompt: 'p', description: 'd', agent: 'a', id: 's1' }))
      .toEqual({ type: 'subtask', prompt: 'p', description: 'd', agent: 'a', id: 's1' })
    const interaction = { type: 'interaction', id: 'i1', kind: 'question', title: 'T', answerSpec: { fields: [] }, status: 'pending' }
    expect(normalizePersistedPart(interaction)).toEqual(interaction)
    const notice = { type: 'notice', id: 'n1', noticeKind: 'warning', text: 'heads up' }
    expect(normalizePersistedPart(notice)).toEqual(notice)
  })

  it('validates and preserves durable plan parts', () => {
    const plan = {
      type: 'plan',
      planId: 'plan-1',
      revision: 1,
      body: 'Plan body',
      submittedAt: '2026-07-21T00:00:00.000Z',
      status: 'pending',
    }
    expect(normalizePersistedPart(plan)).toEqual(plan)
    expect(normalizePersistedPart({ ...plan, planId: undefined, id: 'plan-1' }))
      .toMatchObject({ planId: 'plan-1' })
    expect(normalizePersistedPart({ ...plan, revision: 0 })).toBeNull()
    expect(getPartKey(plan)).toBe('plan:plan-1')
  })

  it('still returns null for unknown kinds', () => {
    expect(normalizePersistedPart({ type: 'telemetry', blob: 1 })).toBeNull()
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

  it('keeps a completed tool output when a later empty update arrives (no clobber)', () => {
    const completed = normalizePersistedPart({
      type: 'tool',
      id: 'call_1',
      tool: 'vault_search',
      state: { status: 'completed', input: { q: 'lease' }, output: { hits: 2 } },
    })!
    // A later partial update for the same tool with no captured output/error —
    // its normalized state carries `output: undefined`, `error: undefined`.
    const laterEmpty = normalizePersistedPart({ type: 'tool', id: 'call_1', tool: 'vault_search' })!
    const merged = mergePersistedPart(completed, laterEmpty)
    const state = merged.state as Record<string, unknown>
    // Captured output survives; the settled status is not downgraded to running.
    expect(state.output).toEqual({ hits: 2 })
    expect(state.status).toBe('completed')
    expect(state.input).toEqual({ q: 'lease' })
  })

  it('keeps a tool error message when a later empty update arrives', () => {
    const errored = normalizePersistedPart({
      type: 'tool',
      id: 'call_2',
      tool: 'bash',
      state: { status: 'error', input: { cmd: 'exit 1' }, error: 'exit 1' },
    })!
    const laterEmpty = normalizePersistedPart({ type: 'tool', id: 'call_2', tool: 'bash' })!
    const merged = mergePersistedPart(errored, laterEmpty)
    const state = merged.state as Record<string, unknown>
    expect(state.error).toBe('exit 1')
    expect(state.status).toBe('error')
  })

  it('keeps durable plan and interaction statuses monotonic across stale replay', () => {
    const approved = {
      type: 'plan',
      planId: 'plan-1',
      revision: 1,
      body: 'Plan',
      submittedAt: '2026-07-21T00:00:00.000Z',
      status: 'approved',
      decidedAt: '2026-07-21T00:01:00.000Z',
    }
    expect(mergePersistedPart(approved, { ...approved, status: 'pending', decidedAt: undefined }))
      .toEqual(approved)

    const newer = { ...approved, revision: 2, status: 'pending', decidedAt: undefined }
    expect(mergePersistedPart(newer, approved)).toEqual(newer)
    expect(mergePersistedPart(approved, newer)).toEqual(newer)

    const answered = {
      type: 'interaction',
      id: 'ask-1',
      kind: 'question',
      title: 'Question',
      answerSpec: { fields: [] },
      status: 'answered',
      answers: { q0: ['Yes'] },
    }
    expect(mergePersistedPart(answered, { ...answered, status: 'pending', answers: undefined }))
      .toEqual(answered)
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
    expect(finalized[0]?.text).toBe('Hello ')
    expect(finalized[2]?.text).toBe('world')
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
    expect(finalized[2]?.text).toBe('a corrected final answer')
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

describe('terminalizeDanglingToolParts', () => {
  it('settles a running tool part as a terminal error with terminalized metadata', () => {
    const terminalized = terminalizeDanglingToolPart({
      type: 'tool',
      id: 'call_1',
      tool: 'search',
      state: { status: 'running', input: { q: 'x' }, metadata: { origin: 'agent' } },
    })
    expect(terminalized.state).toEqual({
      status: 'error',
      input: { q: 'x' },
      error: MISSING_TOOL_TERMINAL_ERROR,
      metadata: { origin: 'agent', terminalized: true, terminalReason: MISSING_TOOL_TERMINAL_REASON },
    })
  })

  it('preserves an already-captured error message', () => {
    const terminalized = terminalizeDanglingToolPart({
      type: 'tool',
      id: 'call_1',
      tool: 'search',
      state: { status: 'running', error: 'network reset' },
    })
    expect((terminalized.state as JsonRecord).error).toBe('network reset')
    expect((terminalized.state as JsonRecord).status).toBe('error')
  })

  it('passes settled tool parts and non-tool parts through untouched', () => {
    const completed = { type: 'tool', id: 'call_1', tool: 'search', state: { status: 'completed', output: 'ok' } }
    const errored = { type: 'tool', id: 'call_2', tool: 'search', state: { status: 'error', error: 'boom' } }
    const text = { type: 'text', text: 'hello' }
    expect(terminalizeDanglingToolParts([completed, errored, text])).toEqual([completed, errored, text])
  })

  it('finalizeAssistantParts leaves no running tool part after an abnormal stream end', () => {
    const { order, map } = buildParts([
      { type: 'text', id: 't1', text: 'working on it' },
      { type: 'tool', id: 'call_1', tool: 'search', state: { status: 'running', input: { q: 'x' } } },
    ])
    const finalized = finalizeAssistantParts(order, map, 'working on it')
    const tool = finalized.find((part) => part.type === 'tool')
    expect((tool?.state as JsonRecord).status).toBe('error')
    expect((tool?.state as JsonRecord).error).toBe(MISSING_TOOL_TERMINAL_ERROR)
    expect(
      finalized.some((part) => part.type === 'tool' && (part.state as JsonRecord)?.status === 'running'),
    ).toBe(false)
  })
})

describe('terminalizeDanglingAssistantToolUpdates', () => {
  it('returns only the dangling settlements and folds them back into the map', () => {
    const { order, map } = buildParts([
      { type: 'tool', id: 'call_1', tool: 'read', state: { status: 'running', input: { path: 'a.md' } } },
      { type: 'tool', id: 'call_1', tool: 'read', state: { status: 'completed', output: 'one' } },
      { type: 'tool', id: 'call_2', tool: 'read', state: { status: 'running', input: { path: 'b.md' } } },
    ])

    const updates = terminalizeDanglingAssistantToolUpdates(order, map, 'final text')

    expect(updates).toHaveLength(1)
    expect(updates[0]?.id).toBe('call_2')
    expect((updates[0]?.state as JsonRecord).status).toBe('error')

    expect((map.get('tool:call_1')?.state as JsonRecord).status).toBe('completed')
    expect((map.get('tool:call_2')?.state as JsonRecord).status).toBe('error')
  })

  it('returns nothing when every tool settled', () => {
    const { order, map } = buildParts([
      { type: 'tool', id: 'call_1', tool: 'read', state: { status: 'completed', output: 'one' } },
    ])
    expect(terminalizeDanglingAssistantToolUpdates(order, map, 'done')).toEqual([])
  })
})

describe('collapseRedundantTextParts', () => {
  it('folds consecutive identical text parts into one', () => {
    const collapsed = collapseRedundantTextParts([
      { type: 'text', text: 'answer' },
      { type: 'text', id: 't1', text: 'answer' },
      { type: 'tool', id: 'call_1', tool: 'search', state: { status: 'completed' } },
    ])
    expect(collapsed).toEqual([
      { type: 'text', text: 'answer' },
      { type: 'tool', id: 'call_1', tool: 'search', state: { status: 'completed' } },
    ])
  })

  it('drops empty text parts only when a non-empty text part exists', () => {
    expect(
      collapseRedundantTextParts([
        { type: 'text', text: '' },
        { type: 'text', text: 'real' },
      ]),
    ).toEqual([{ type: 'text', text: 'real' }])

    // All-empty text survives (nothing better to show).
    expect(collapseRedundantTextParts([{ type: 'text', text: '' }])).toEqual([{ type: 'text', text: '' }])
  })
})

describe('finalizePendingInteractionParts', () => {
  const PENDING = { type: 'interaction', id: 'int-1', kind: 'question', status: 'pending' }

  it('settles only pending interaction parts with the given outcome', () => {
    const parts = [
      { ...PENDING },
      { ...PENDING, id: 'int-2', status: 'expired' },
      { type: 'text', text: 'hi' },
    ]
    const answered = finalizePendingInteractionParts(parts, 'answered')
    expect(answered[0]?.status).toBe('answered')
    expect(answered[1]?.status).toBe('expired')
    expect(answered[2]).toEqual({ type: 'text', text: 'hi' })

    const expired = finalizePendingInteractionParts([{ ...PENDING }], 'expired')
    expect(expired[0]?.status).toBe('expired')
  })
})

describe('attachment part keys', () => {
  it('keys path-bearing file/image parts by their storage path', () => {
    expect(getPartKey({ type: 'image', path: 'assets/agent/shot.png' })).toBe('attachment:assets/agent/shot.png')
    expect(getPartKey({ type: 'file', path: 'uploads/agent/note.txt' })).toBe(attachmentPartKey('uploads/agent/note.txt'))
  })

  it('folds re-emissions of the same path into one part', () => {
    const { order, map } = buildParts([
      { type: 'image', path: 'assets/shot.png', name: 'shot.png' },
      { type: 'image', path: 'assets/shot.png', name: 'shot.png', mediaType: 'image/png' },
    ])
    expect(order).toEqual(['attachment:assets/shot.png'])
    expect(map.get('attachment:assets/shot.png')).toMatchObject({ mediaType: 'image/png' })
  })

  it('keeps the legacy lane key for path-less file/image parts', () => {
    expect(getPartKey({ type: 'file', id: 'f1', url: 'https://example.com/a.pdf' })).toBe('file:f1')
  })
})
