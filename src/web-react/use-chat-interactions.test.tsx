// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

import {
  cancelChatInteraction,
  hydrateChatInteractions,
  resolveChatInteraction,
  restoreChatInteractions,
  terminalizePendingChatInteractions,
  upsertChatInteraction,
  useChatInteractions,
} from './use-chat-interactions'
import type { ChatInteraction } from './chat-interactions'
import type { InteractionRequestWire } from './chat-interactions'

afterEach(cleanup)

function question(id: string, overrides: Partial<ChatInteraction> = {}): ChatInteraction {
  return {
    id,
    kind: 'question',
    title: 'Which tone?',
    fields: [{ type: 'text', name: 'q0', label: 'Which tone?', required: true }],
    status: 'pending',
    ...overrides,
  }
}

function wireRequest(id: string, title = 'Which tone?'): InteractionRequestWire {
  return {
    id,
    kind: 'question',
    title,
    answerSpec: { fields: [{ type: 'text', name: 'q0', label: title, required: true }] },
  } as InteractionRequestWire
}

describe('interaction reducers', () => {
  it('drops a pending question whose content duplicates another pending question (different id)', () => {
    const list = upsertChatInteraction([], question('a'))
    expect(upsertChatInteraction(list, question('b'))).toBe(list)
    // A different question is not a duplicate.
    expect(upsertChatInteraction(list, question('c', { title: 'Other ask?' }))).toHaveLength(2)
  })

  it('never resurrects a resolved card from a replayed pending snapshot (forward-only)', () => {
    const answered = [question('a', { status: 'answered' as const })]
    expect(upsertChatInteraction(answered, question('a'))).toBe(answered)
  })

  it('applies cancel events only to pending asks, mapping timeout to expired', () => {
    const list = [question('a'), question('b', { status: 'answered' as const, title: 'Other?' })]
    const cancelled = cancelChatInteraction(list, { id: 'a', reason: 'timeout' })
    expect(cancelled[0]).toMatchObject({ status: 'expired', cancelReason: 'timeout' })
    // Terminal asks are untouched; unknown ids are a no-op.
    expect(cancelChatInteraction(cancelled, { id: 'a' })).toBe(cancelled)
    expect(cancelChatInteraction(cancelled, { id: 'missing' })).toBe(cancelled)
  })

  it('marks local resolution forward-only', () => {
    const list = [question('a')]
    const resolved = resolveChatInteraction(list, 'a', 'answered', { q0: ['Formal'] })
    expect(resolved[0]).toMatchObject({ status: 'answered', answers: { q0: ['Formal'] } })
    expect(resolveChatInteraction(resolved, 'a', 'expired')).toBe(resolved)
  })

  it('settles every pending ask when the turn ends', () => {
    const list = [question('a'), question('b', { title: 'Other?' }), question('c', { status: 'declined' as const, title: 'Done?' })]
    const settled = terminalizePendingChatInteractions(list, 'answered')
    expect(settled.map((item) => item.status)).toEqual(['answered', 'answered', 'declined'])
    expect(terminalizePendingChatInteractions(settled, 'expired')).toBe(settled)
  })

  it('restores outstanding asks without guessing how an unlisted ask settled', () => {
    const list = [question('gone'), question('kept', { title: 'Kept?' })]
    const restored = restoreChatInteractions(list, [wireRequest('kept', 'Kept?'), wireRequest('new', 'New ask?')])
    expect(restored.find((item) => item.id === 'gone')?.status).toBe('pending')
    expect(restored.find((item) => item.id === 'kept')?.status).toBe('pending')
    expect(restored.find((item) => item.id === 'new')?.status).toBe('pending')
    expect(restored).toHaveLength(3)
  })

  it('replaces an obsolete duplicate id with the authoritative outstanding id', () => {
    const restored = restoreChatInteractions([question('old-id')], [wireRequest('current-id')])
    expect(restored).toEqual([expect.objectContaining({ id: 'current-id', status: 'pending' })])
  })

  it('hydrates terminal status and acknowledged answers from durable projections', () => {
    const hydrated = hydrateChatInteractions(
      [question('a')],
      [question('a', { status: 'answered', answers: { q0: ['Formal'] } })],
    )
    expect(hydrated[0]).toMatchObject({ status: 'answered', answers: { q0: ['Formal'] } })
  })
})

describe('useChatInteractions', () => {
  it('tracks pending asks through the upsert → cancel → resolve → reset lifecycle', () => {
    const { result } = renderHook(() => useChatInteractions())

    act(() => {
      result.current.upsert(question('a'))
      result.current.upsert(question('b', { title: 'Other?' }))
    })
    expect(result.current.pending.map((item) => item.id)).toEqual(['a', 'b'])

    act(() => result.current.applyCancel({ id: 'a', reason: 'timeout' }))
    expect(result.current.pending.map((item) => item.id)).toEqual(['b'])
    expect(result.current.interactions.find((item) => item.id === 'a')?.status).toBe('expired')

    act(() => result.current.markResolved('b', 'answered'))
    expect(result.current.pending).toEqual([])

    act(() => result.current.reset())
    expect(result.current.interactions).toEqual([])
  })

  it('dedupes a re-emitted duplicate ask by content', () => {
    const { result } = renderHook(() => useChatInteractions())
    act(() => {
      result.current.upsert(question('a'))
      result.current.upsert(question('duplicate-id-same-content'))
    })
    expect(result.current.interactions).toHaveLength(1)
  })

  it('exposes durable hydration through the hook', () => {
    const { result } = renderHook(() => useChatInteractions())
    act(() => result.current.upsert(question('a')))
    act(() => result.current.hydrate([
      question('a', { status: 'answered', answers: { q0: ['Formal'] } }),
    ]))
    expect(result.current.interactions[0]).toMatchObject({
      status: 'answered',
      answers: { q0: ['Formal'] },
    })
  })
})
