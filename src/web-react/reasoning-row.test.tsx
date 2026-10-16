// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'

import { ReasoningRow } from './reasoning-row'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
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
