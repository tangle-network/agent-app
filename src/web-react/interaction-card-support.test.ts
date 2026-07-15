import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildAnswerData,
  createInteractionAnswerSubmitter,
  fieldAnswer,
  hasSecretField,
  isLateAnswerableStatus,
  lateAnswerMessage,
  INTERACTION_SUBMIT_TIMEOUT_MESSAGE,
} from './interaction-card-support'
import type { ChatInteraction, ChatInteractionField } from './chat-interactions'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const SELECT: ChatInteractionField = {
  type: 'select',
  name: 'q0',
  label: 'Pick one',
  required: true,
  multi: false,
  options: [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
  ],
}

describe('fieldAnswer / buildAnswerData', () => {
  it('shapes select answers as string arrays and single-select custom as the sole answer', () => {
    expect(fieldAnswer(SELECT, { q0: { selected: ['a'] } })).toEqual(['a'])
    const custom = { ...SELECT, allowCustom: true } as ChatInteractionField
    expect(fieldAnswer(custom, { q0: { selected: ['a'], custom: 'own' } })).toEqual(['own'])
    const multi = { ...SELECT, multi: true, allowCustom: true } as ChatInteractionField
    expect(fieldAnswer(multi, { q0: { selected: ['a', 'b'], custom: 'own' } })).toEqual(['a', 'b', 'own'])
  })

  it('parses numbers and booleans, and rejects non-finite number text', () => {
    const num: ChatInteractionField = { type: 'number', name: 'n', label: 'N', required: true }
    expect(fieldAnswer(num, { n: { text: '42' } })).toBe(42)
    expect(fieldAnswer(num, { n: { text: 'nope' } })).toBeNull()
    const bool: ChatInteractionField = { type: 'boolean', name: 'b', label: 'B', required: true }
    expect(fieldAnswer(bool, { b: { selected: ['true'] } })).toBe(true)
    expect(fieldAnswer(bool, {})).toBeNull()
  })

  it('returns null while a required field is unanswered and skips optional ones', () => {
    const optionalText: ChatInteractionField = { type: 'text', name: 'note', label: 'Note', required: false }
    expect(buildAnswerData([SELECT, optionalText], {})).toBeNull()
    expect(buildAnswerData([SELECT, optionalText], { q0: { selected: ['a'] } })).toEqual({ q0: ['a'] })
  })
})

describe('late answers', () => {
  it('gates on expired/cancelled and blocks secret-bearing asks', () => {
    expect(isLateAnswerableStatus('expired')).toBe(true)
    expect(isLateAnswerableStatus('cancelled')).toBe(true)
    expect(isLateAnswerableStatus('answered')).toBe(false)
    expect(hasSecretField([{ type: 'secret', name: 's', label: 'S', required: true }])).toBe(true)
  })

  it('renders a self-contained message with option labels, context, and secrets omitted', () => {
    const interaction: ChatInteraction = {
      id: 'i1',
      kind: 'question',
      title: 'Pick one',
      body: 'Because reasons.',
      fields: [SELECT, { type: 'text', name: 'why', label: 'Why', required: false }],
      status: 'expired',
    }
    expect(lateAnswerMessage(interaction, { q0: ['a'], why: 'fits' })).toBe([
      'Regarding your earlier question: "Pick one"',
      'Context: Because reasons.',
      'My answer: Pick one: Alpha\nWhy: fits',
    ].join('\n'))
    // A single answer skips the label prefix.
    expect(lateAnswerMessage({ ...interaction, body: undefined, fields: [SELECT] }, { q0: ['b'] })).toBe([
      'Regarding your earlier question: "Pick one"',
      'My answer: Beta',
    ].join('\n'))
  })
})

describe('createInteractionAnswerSubmitter', () => {
  it('POSTs routing fields + id/outcome/data and normalizes ok / 410 / error bodies', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    let response = new Response(JSON.stringify({ ok: true }), { status: 200 })
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown> })
      return response
    }) as unknown as typeof fetch
    const submit = createInteractionAnswerSubmitter({
      url: '/api/chat/interactions',
      body: { workspaceId: 'ws-1', threadId: 'thread-1' },
      fetchImpl,
    })

    expect(await submit({ id: 'int-1', outcome: 'accepted', data: { q0: ['a'] } })).toEqual({ ok: true })
    expect(calls[0]).toEqual({
      url: '/api/chat/interactions',
      body: { workspaceId: 'ws-1', threadId: 'thread-1', id: 'int-1', outcome: 'accepted', data: { q0: ['a'] } },
    })

    response = new Response(JSON.stringify({ code: 'INTERACTION_EXPIRED', error: 'gone' }), { status: 410 })
    expect(await submit({ id: 'int-1', outcome: 'accepted', data: {} })).toEqual({ ok: false, expired: true, message: 'gone' })

    response = new Response('<html>bad gateway</html>', { status: 502 })
    expect(await submit({ id: 'int-1', outcome: 'declined' })).toEqual({ ok: false, expired: false, message: 'Answer failed (502)' })
  })

  it('supports a per-submission URL (session-in-path routes)', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch
    const submit = createInteractionAnswerSubmitter({
      url: () => '/api/sessions/sess-9/interactions',
      fetchImpl,
    })
    await submit({ id: 'int-1', outcome: 'accepted', data: {} })
    expect(urls).toEqual(['/api/sessions/sess-9/interactions'])
  })

  it('aborts after the timeout with the retryable timeout message (gtm #489)', async () => {
    vi.useFakeTimers()
    const fetchImpl = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })) as unknown as typeof fetch
    const submit = createInteractionAnswerSubmitter({ url: '/api/chat/interactions', fetchImpl })

    const pending = submit({ id: 'int-1', outcome: 'accepted', data: {} })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await pending).toEqual({ ok: false, expired: false, message: INTERACTION_SUBMIT_TIMEOUT_MESSAGE })
  })
})
