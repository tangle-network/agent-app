// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StudioToastProvider, useStudioToast, type StudioToastInput } from './studio-toasts'

let api: ReturnType<typeof useStudioToast>

function Harness() {
  api = useStudioToast()
  return null
}

function mount() {
  render(<StudioToastProvider><Harness /></StudioToastProvider>)
}

function publish(input: StudioToastInput) {
  act(() => { api.toast(input) })
}

describe('StudioToastProvider', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('renders a toast and dismisses an action with its exact reason', () => {
    mount()
    const run = vi.fn()
    const onDismiss = vi.fn()
    publish({ message: 'Saved', action: { label: 'View', run }, onDismiss })

    expect(screen.getByRole('status').textContent).toContain('Saved')
    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    expect(run).toHaveBeenCalledOnce()
    expect(onDismiss).toHaveBeenCalledOnce()
    expect(onDismiss).toHaveBeenCalledWith('action')
    act(() => vi.advanceTimersByTime(180))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('dismisses with dismissed and fires exactly once after two fast clicks', () => {
    mount()
    const onDismiss = vi.fn()
    publish({ message: 'Ready', durationMs: 0, onDismiss })
    const close = screen.getByRole('button', { name: 'Dismiss' })
    fireEvent.click(close)
    fireEvent.click(close)
    expect(onDismiss).toHaveBeenCalledOnce()
    expect(onDismiss).toHaveBeenCalledWith('dismissed')
  })

  it('times out after the default 3500ms', () => {
    mount()
    const onDismiss = vi.fn()
    publish({ message: 'Finished', onDismiss })
    act(() => vi.advanceTimersByTime(3499))
    expect(onDismiss).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(onDismiss).toHaveBeenCalledWith('timeout')
    act(() => vi.advanceTimersByTime(180))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('moves the viewport above and back below the generation dock', () => {
    mount()
    const viewport = screen.getByRole('region', { name: 'Notifications' })
    expect(viewport.style.bottom).toBe('22px')
    act(() => api.setDockLift(190))
    expect(viewport.style.bottom).toBe('200px')
    act(() => api.setDockLift(null))
    expect(viewport.style.bottom).toBe('22px')
  })

  it('throws clearly outside the provider', () => {
    function Outside() {
      useStudioToast()
      return null
    }
    expect(() => render(<Outside />)).toThrow('useStudioToast must be used within a StudioToastProvider')
  })
})
