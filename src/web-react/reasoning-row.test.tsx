// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'

import { ReasoningRow } from './reasoning-row'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** The row's disclosure button: the run-row trigger that names the region it opens. */
function trigger(container: HTMLElement): HTMLElement {
  const button = container.querySelector('button[aria-expanded]')
  if (!button) throw new Error('no reasoning row rendered')
  return button as HTMLElement
}

describe('ReasoningRow', () => {
  it('renders nothing when the turn has no reasoning', () => {
    expect(render(<ReasoningRow text="" thinking />).container.innerHTML).toBe('')
    expect(render(<ReasoningRow text={' \n '} startedAt={1_000} endedAt={2_000} />).container.innerHTML).toBe('')
  })

  it('streams the reasoning open under a Thinking timer that counts from when the model started', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const { container, rerender } = render(<ReasoningRow text="Checking the" startedAt={7_000} />)
    // Started 3 s before this row mounted: the timer reads the stream's start, not the mount.
    expect(trigger(container).textContent).toContain('Thinking · 3s')
    expect(trigger(container).getAttribute('aria-expanded')).toBe('true')
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(trigger(container).textContent).toContain('Thinking · 5s')

    // Each delta lands in the open row while the model is still thinking.
    rerender(<ReasoningRow text="Checking the ready rooms first." startedAt={7_000} />)
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(container.textContent).toContain('Checking the ready rooms first.')
    expect(trigger(container).textContent).toContain('Thinking · 6s')
  })

  it('collapses to "Thought for N seconds" when the answer starts, and opens again on a click', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const { container, rerender } = render(<ReasoningRow text="Need the count." startedAt={7_000} />)
    rerender(<ReasoningRow text="Need the count." startedAt={7_000} endedAt={11_400} />)
    const button = trigger(container)
    expect(button.textContent).toContain('Thought for 4 seconds')
    expect(button.textContent).not.toContain('Thinking')
    // The collapsed row previews what was considered.
    expect(button.textContent).toContain('Need the count.')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    expect(trigger(container).getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(trigger(container).getAttribute('aria-controls')!)?.textContent).toContain('Need the count.')
  })

  it('times the run itself when the stream sends no timestamps', () => {
    vi.useFakeTimers()
    vi.setSystemTime(50_000)
    const { container, rerender } = render(<ReasoningRow text="Weighing it." thinking />)
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(trigger(container).textContent).toContain('Thinking · 3s')
    rerender(<ReasoningRow text="Weighing it." thinking={false} />)
    expect(trigger(container).textContent).toContain('Thought for 3 seconds')
    expect(trigger(container).getAttribute('aria-expanded')).toBe('false')
  })

  it('starts its own timer at the first reasoning, not when the turn began', () => {
    vi.useFakeTimers()
    vi.setSystemTime(80_000)
    // A streaming message mounts the row before any reasoning arrives (a sandbox still starting).
    const { container, rerender } = render(<ReasoningRow text="" thinking />)
    act(() => { vi.advanceTimersByTime(5_000) })
    rerender(<ReasoningRow text="First thought." thinking />)
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(trigger(container).textContent).toContain('Thinking · 2s')
    rerender(<ReasoningRow text="First thought." thinking={false} />)
    expect(trigger(container).textContent).toContain('Thought for 2 seconds')
  })

  it('shows a saved turn collapsed: with times it says how long, without them it still opens', () => {
    const timed = render(<ReasoningRow text="Saved reasoning." startedAt={1_000} endedAt={2_200} />)
    expect(trigger(timed.container).textContent).toContain('Thought for 1 second')
    expect(trigger(timed.container).getAttribute('aria-expanded')).toBe('false')
    timed.unmount()

    const legacy = render(<ReasoningRow text="Saved before times were kept." />)
    expect(trigger(legacy.container).textContent).toContain('Thought process')
    fireEvent.click(trigger(legacy.container))
    const region = document.getElementById(trigger(legacy.container).getAttribute('aria-controls')!)
    expect(region?.textContent).toContain('Saved before times were kept.')
  })
})

// This regression exercises the visible reading surface, including smoothed deltas.
describe('reading reasoning while it streams', () => {
  it('renders every available delta immediately without artificial typing', () => {
    const { container, rerender } = render(<ReasoningRow text="Available now." thinking />)
    expect(container.textContent).toContain('Available now.')
    rerender(<ReasoningRow text="Available now. The entire next delta." thinking />)
    expect(container.textContent).toContain('Available now. The entire next delta.')
  })
  it('follows, stops immediately on upward input, preserves position on append, and resumes at the bottom', () => {
    vi.useFakeTimers()
    let resized: () => void = () => {}
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback }
      observe() {}
      disconnect() {}
    })
    const { container, rerender, getByRole } = render(<ReasoningRow text="First thought." thinking />)
    const viewport = container.querySelector('[data-reasoning]') as HTMLElement
    let height = 1_000
    let top = 600
    Object.defineProperties(viewport, {
      clientHeight: { get: () => 400 },
      scrollHeight: { get: () => height },
      scrollTop: { get: () => top, set: (value: number) => { top = Math.min(value, height - 400) } },
    })
    const append = (text: string) => {
      height += 100
      rerender(<ReasoningRow text={text} thinking />)
      act(() => { vi.advanceTimersByTime(1_000); resized() })
    }
    append('First thought. Following.')
    expect(top).toBe(700)
    // Pause before the scroll event; a delta can land between input and scroll.
    fireEvent.wheel(viewport, { deltaY: -5 })
    // A queued programmatic scroll must not undo the pause before input moves.
    fireEvent.scroll(viewport)
    act(() => { resized() })
    expect(getByRole('button', { name: 'Jump to latest reasoning' })).toBeTruthy()
    top -= 5
    append('First thought. Following. Reading now.')
    expect(top).toBe(695)
    expect(getByRole('button', { name: 'Jump to latest reasoning' })).toBeTruthy()
    fireEvent.scroll(viewport)
    append('First thought. Following. Reading now. Still reading.')
    expect(top).toBe(695)
    fireEvent.click(getByRole('button', { name: 'Jump to latest reasoning' }))
    expect(top).toBe(height - 400)
    expect(document.activeElement).toBe(viewport)
    append('First thought. Following. Reading now. Still reading. Latest.')
    expect(top).toBe(height - 400)
    top = 100
    fireEvent.scroll(viewport)
    append('First thought. Following. Reading now. Still reading. Latest. Scrollbar reading.')
    expect(top).toBe(100)
    top = height - 400
    fireEvent.scroll(viewport)
    append('First thought. Following. Reading now. Still reading. Latest. Scrollbar reading. Resumed.')
    expect(top).toBe(height - 400)
    // Content collapse can clamp scrollTop before ResizeObserver runs.
    height -= 200
    top = height - 400
    fireEvent.scroll(viewport)
    append('First thought. After a tool disclosure collapses, keep following.')
    expect(top).toBe(height - 400)
  })

  it.each(['ArrowUp', 'PageUp', 'Home', 'touch'])('keeps the reader in place for %s, including when reasoning ends', (key) => {
    vi.useFakeTimers()
    const { container, rerender } = render(<ReasoningRow text="First thought." thinking />)
    const viewport = container.querySelector('[data-reasoning]') as HTMLElement
    Object.defineProperties(viewport, {
      clientHeight: { value: 400 }, scrollHeight: { value: 1_000 }, scrollTop: { value: 600, writable: true },
    })
    if (key === 'touch') {
      fireEvent.touchStart(viewport, { touches: [{ clientY: 100 }] })
      fireEvent.touchMove(viewport, { touches: [{ clientY: 120 }] })
    } else fireEvent.keyDown(viewport, { key })
    rerender(<ReasoningRow text="First thought. More." thinking />)
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(viewport.scrollTop).toBe(600)
    rerender(<ReasoningRow text="First thought. More." thinking={false} />)
    expect(trigger(container).getAttribute('aria-expanded')).toBe('true')
  })
})
