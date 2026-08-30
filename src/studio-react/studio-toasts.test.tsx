// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StudioToastProvider, useStudioToast, type StudioToastInput } from './studio-toasts'

let api: ReturnType<typeof useStudioToast>

function Harness() {
  api = useStudioToast()
  return null
}

function DismissOnUnmount() {
  const { dismiss, toast } = useStudioToast()
  useEffect(() => {
    const id = toast({ message: 'Ready', durationMs: 0 })
    return () => dismiss(id)
  }, [dismiss, toast])
  return null
}

function mount() {
  return render(<StudioToastProvider><Harness /></StudioToastProvider>)
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

  it('cancels a pending removal when the provider unmounts', () => {
    const { unmount } = mount()
    publish({ message: 'Ready', durationMs: 0 })
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not schedule removal from a child unmount cleanup', () => {
    const { unmount } = render(
      <StudioToastProvider><DismissOnUnmount /></StudioToastProvider>,
    )

    expect(screen.getByRole('status')).toBeTruthy()
    unmount()
    expect(vi.getTimerCount()).toBe(0)
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

  it('hydrates without a portal mismatch and mounts notifications after effects', async () => {
    const tree = (
      <StudioToastProvider>
        <div>Studio content</div>
      </StudioToastProvider>
    )
    const serverMarkup = renderToString(tree)
    const container = document.createElement('div')
    container.innerHTML = serverMarkup
    document.body.append(container)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let root: Root | undefined

    await act(async () => {
      root = hydrateRoot(container, tree)
    })

    const hydrationErrors = consoleError.mock.calls.filter((call) =>
      call.some((value) => /hydration|mismatch/i.test(String(value))),
    )
    expect(hydrationErrors).toEqual([])
    expect(document.body.querySelector('[role="region"][aria-label="Notifications"]')).not.toBeNull()

    act(() => root?.unmount())
    container.remove()
  })

  it('throws clearly outside the provider', () => {
    function Outside() {
      useStudioToast()
      return null
    }
    expect(() => render(<Outside />)).toThrow('useStudioToast must be used within a StudioToastProvider')
  })
})
