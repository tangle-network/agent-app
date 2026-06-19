// @vitest-environment jsdom
/**
 * Streaming-perf invariant: while the active message reveals via the smooth
 * typewriter, markdown is RE-PARSED only when the floored visible length
 * actually advances — not on every rAF frame. The body is memoized on the
 * revealed `content`, so frames that don't move the floored length reuse the
 * prior parse. Historical (non-streaming) messages parse exactly once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'

import { ChatMessages, type ChatUiMessage } from '../../src/web-react/index'

afterEach(cleanup)

// Drive requestAnimationFrame manually so we control the per-frame dt and can
// step the reveal one frame at a time.
let rafCallbacks: Array<{ id: number; cb: FrameRequestCallback }> = []
let rafId = 0
let now = 0

beforeEach(() => {
  rafCallbacks = []
  rafId = 0
  now = 0
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    const id = ++rafId
    rafCallbacks.push({ id, cb })
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
    rafCallbacks = rafCallbacks.filter((r) => r.id !== id)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Flush every currently-queued rAF callback, advancing the clock by `dtMs`.
 *  Callbacks scheduled DURING the flush run on the next flush, not this one. */
function flushFrame(dtMs: number) {
  now += dtMs
  const pending = rafCallbacks
  rafCallbacks = []
  act(() => {
    for (const { cb } of pending) cb(now)
  })
}

describe('streaming markdown re-parse', () => {
  it('parses each revealed prefix at most once, never re-parsing an unchanged prefix', () => {
    // renderMarkdown is the markdown parse. Record every content it receives.
    const parsed: string[] = []
    const renderMarkdown = vi.fn((content: string) => {
      parsed.push(content)
      return createElement('p', null, content)
    })

    const messages: ChatUiMessage[] = [
      { id: 'a1', role: 'assistant', content: 'hello world this is a streamed answer' },
    ]

    render(
      createElement(ChatMessages, {
        messages,
        loading: true, // last assistant message → streaming
        renderMarkdown,
      }),
    )

    // Drive many small-dt frames. Each frame re-renders the component (the rAF
    // bumps a state counter), but the memoized body must only re-invoke the
    // parser when the FLOORED revealed prefix actually changes. Sub-character
    // frames (dt where the floored length doesn't move) must add no new parse.
    for (let i = 0; i < 80 && rafCallbacks.length > 0; i++) flushFrame(3)

    // The reveal fully completed (final prefix == full content) ...
    expect(parsed[parsed.length - 1]).toBe('hello world this is a streamed answer')
    // ... and the invariant: no prefix was parsed twice. If the parse ran every
    // frame instead of every floored-length change, the same prefix would
    // repeat and this set would be smaller than the call count.
    expect(new Set(parsed).size).toBe(parsed.length)
    // The parse count equals the number of distinct floored lengths crossed —
    // at most the content length, far fewer than the ~80 frames driven.
    expect(parsed.length).toBeLessThanOrEqual('hello world this is a streamed answer'.length + 1)
  })

  it('stops scheduling rAF once the reveal has caught up to the target', () => {
    const messages: ChatUiMessage[] = [
      { id: 'a1', role: 'assistant', content: 'short' },
    ]
    render(
      createElement(ChatMessages, {
        messages,
        loading: true,
        renderMarkdown: (c: string) => createElement('p', null, c),
      }),
    )

    // Reveal everything with a big-dt frame, then drain. Once caught up the
    // loop must stop queueing new frames (idle streaming message → no rAF).
    for (let i = 0; i < 20 && rafCallbacks.length > 0; i++) flushFrame(1000)
    expect(rafCallbacks.length).toBe(0)
  })

  it('a non-streaming (historical) message parses exactly once', () => {
    const renderMarkdown = vi.fn((content: string) => createElement('p', null, content))
    const messages: ChatUiMessage[] = [
      { id: 'a1', role: 'assistant', content: 'done answer' },
    ]
    render(
      createElement(ChatMessages, {
        messages,
        loading: false, // not streaming → full text immediately, no rAF
        renderMarkdown,
      }),
    )
    // No rAF should have been queued for a non-streaming message.
    expect(rafCallbacks.length).toBe(0)
    expect(renderMarkdown).toHaveBeenCalledTimes(1)
    expect(renderMarkdown).toHaveBeenCalledWith('done answer')
  })
})
