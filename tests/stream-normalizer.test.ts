import { describe, expect, it } from 'vitest'

import {
  finalizeAssistantParts,
  getPartKey,
  mergePersistedPart,
  MISSING_TOOL_TERMINAL_ERROR,
  MISSING_TOOL_TERMINAL_REASON,
  normalizePersistedPart,
  resolveToolId,
  terminalizeDanglingAssistantToolUpdates,
} from '../src/stream'

describe('stream-normalizer', () => {
  it('resolves stable tool call ids before transient part ids', () => {
    expect(resolveToolId({ id: 'part_1', callID: 'call_1', tool: 'read' })).toBe('call_1')
    expect(resolveToolId({ id: 'part_1', toolCallId: 'call_1', tool: 'read' })).toBe('call_1')
  })

  it('merges tool snapshots by stable call id and preserves prior state fields', () => {
    const running = normalizePersistedPart({
      type: 'tool',
      id: 'part_running',
      toolCallId: 'call_1',
      tool: 'read',
      state: { status: 'running', input: { path: 'a.md' }, metadata: { source: 'live' } },
    })!
    const completed = normalizePersistedPart({
      type: 'tool',
      id: 'part_completed',
      toolCallId: 'call_1',
      tool: 'read',
      state: { status: 'completed', output: 'contents' },
    })!

    expect(getPartKey(running)).toBe(getPartKey(completed))
    expect(mergePersistedPart(running, completed)).toMatchObject({
      callID: 'call_1',
      state: {
        status: 'completed',
        input: { path: 'a.md' },
        output: 'contents',
        metadata: { source: 'live' },
      },
    })
  })

  it('terminalizes dangling running tools when finalizing assistant output', () => {
    const running = normalizePersistedPart({
      type: 'tool',
      id: 'part_1',
      callID: 'call_1',
      tool: 'read',
      state: { status: 'running', input: { path: 'a.md' } },
    })!
    const key = getPartKey(running)
    const parts = finalizeAssistantParts([key], new Map([[key, running]]), 'done')
    const tool = parts.find((part) => String(part.type ?? '') === 'tool')!

    expect(tool.state).toMatchObject({
      status: 'error',
      input: { path: 'a.md' },
      error: MISSING_TOOL_TERMINAL_ERROR,
      metadata: {
        terminalized: true,
        terminalReason: MISSING_TOOL_TERMINAL_REASON,
      },
    })
  })

  it('returns dangling tool updates once and writes them back to the part map', () => {
    const running = normalizePersistedPart({
      type: 'tool',
      id: 'part_1',
      callID: 'call_1',
      tool: 'read',
      state: { status: 'running', input: { path: 'a.md' } },
    })!
    const key = getPartKey(running)
    const partMap = new Map([[key, running]])

    const updates = terminalizeDanglingAssistantToolUpdates([key], partMap, 'done')

    expect(updates).toHaveLength(1)
    expect(partMap.get(key)?.state).toMatchObject({
      status: 'error',
      input: { path: 'a.md' },
      metadata: { terminalized: true },
    })
    expect(terminalizeDanglingAssistantToolUpdates([key], partMap, 'done')).toEqual([])
  })
})
