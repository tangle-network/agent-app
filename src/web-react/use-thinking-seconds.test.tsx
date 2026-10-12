// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useThinkingSeconds } from './index'

describe('useThinkingSeconds', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('counts whole seconds while active', () => {
    const { result } = renderHook(() => useThinkingSeconds(true))
    expect(result.current).toBe(0)
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(result.current).toBe(3)
  })

  it('does not advance while inactive', () => {
    const { result } = renderHook(() => useThinkingSeconds(false))
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(result.current).toBe(0)
  })

  it('resets to 0 when reactivated rather than resuming the stale count', () => {
    const { result, rerender } = renderHook(
      ({ active }) => useThinkingSeconds(active),
      { initialProps: { active: true } },
    )
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(result.current).toBe(4)
    // Deactivate (freezes), then reactivate — the counter must restart at 0.
    rerender({ active: false })
    rerender({ active: true })
    expect(result.current).toBe(0)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBe(1)
  })

  it('clears its interval on unmount', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const { unmount } = renderHook(() => useThinkingSeconds(true))
    unmount()
    expect(clearSpy).toHaveBeenCalled()
  })
})
