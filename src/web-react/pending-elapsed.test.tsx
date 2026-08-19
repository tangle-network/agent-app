// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatMessages, usePendingElapsedSeconds, type ChatUiMessage } from './index'

afterEach(cleanup)

describe('usePendingElapsedSeconds', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts at the server-reported age and ticks forward from it', () => {
    const { result } = renderHook(() => usePendingElapsedSeconds(true, 47_000))
    expect(result.current).toBe(47)
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(result.current).toBe(50)
  })

  it('re-anchors on a fresher server reading instead of double-counting ticks', () => {
    const { result, rerender } = renderHook(
      ({ elapsedMs }) => usePendingElapsedSeconds(true, elapsedMs),
      { initialProps: { elapsedMs: 47_000 as number | undefined } },
    )
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(result.current).toBe(49)
    // The next heartbeat says 52s: the display jumps there and counts on from
    // the NEW anchor — not 52 + the two ticks already counted.
    rerender({ elapsedMs: 52_000 })
    expect(result.current).toBe(52)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBe(53)
  })

  it('counts from zero with no server reading, and freezes while inactive', () => {
    const { result } = renderHook(() => usePendingElapsedSeconds(true))
    expect(result.current).toBe(0)
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(result.current).toBe(2)

    const inactive = renderHook(() => usePendingElapsedSeconds(false, 47_000))
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(inactive.result.current).toBe(47)
  })
})

describe('ChatMessages pending-row elapsed surface', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const userOnly: ChatUiMessage[] = [
    { id: 'u1', role: 'user', content: 'Reconcile the March ledger.' },
  ]

  const rowText = () => {
    const seconds = screen.queryByText(/^\d+s$/)
    if (seconds) return seconds.parentElement?.textContent ?? null
    // Below the threshold the row reads "Thinking..." with no seconds span.
    return screen.queryByText('Thinking...')?.textContent ?? null
  }

  it('shows the server-reported age at mount and keeps ticking', () => {
    render(<ChatMessages messages={userOnly} loading loadingElapsedMs={47_000} />)
    expect(rowText()).toBe('Thinking · 47s')
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(rowText()).toBe('Thinking · 49s')
  })

  it('counts from mount when the server sends no elapsed reading', () => {
    render(<ChatMessages messages={userOnly} loading />)
    expect(rowText()).toBe('Thinking...')
    act(() => {
      vi.advanceTimersByTime(2999)
    })
    expect(rowText()).toBe('Thinking...')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(rowText()).toBe('Thinking · 3s')
  })
})
