// @vitest-environment jsdom
import { Suspense, useState } from 'react'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { lazyRoute, preloadWhenIdle } from './lazy-load-boundary'

function Counter({ label }: { label: string }) {
  const [count, setCount] = useState(0)
  return <button type="button" onClick={() => setCount(count + 1)}>{label} {count}</button>
}

describe('lazyRoute', () => {
  it('renders a preloaded route synchronously, without suspending', async () => {
    const Route = lazyRoute(async () => Counter)
    await Route.preload()
    render(<Suspense fallback={<p>loading</p>}><Route label="People" /></Suspense>)
    expect(screen.getByRole('button').textContent).toBe('People 0')
    expect(screen.queryByText('loading')).toBeNull()
  })

  it('suspends before its module loads, then keeps the mounted state across re-renders', async () => {
    let resolve!: (component: typeof Counter) => void
    const Route = lazyRoute(() => new Promise<typeof Counter>((done) => { resolve = done }))
    const view = render(<Suspense fallback={<p>loading</p>}><Route label="Files" /></Suspense>)
    expect(screen.getByText('loading')).toBeTruthy()
    await act(async () => { resolve(Counter) })
    await screen.findByText('Files 0')
    act(() => screen.getByRole('button').click())
    view.rerender(<Suspense fallback={<p>loading</p>}><Route label="Files" /></Suspense>)
    expect(screen.getByRole('button').textContent).toBe('Files 1')
  })

  it('loads once and retries after a failed load', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(Counter)
    const Route = lazyRoute(load)
    await expect(Route.preload()).rejects.toThrow('offline')
    await Route.preload()
    await Route.preload()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('preloads routes when idle and can be cancelled', async () => {
    vi.useFakeTimers()
    try {
      const a = { preload: vi.fn(async () => {}) }
      const b = { preload: vi.fn(async () => {}) }
      preloadWhenIdle([a])
      preloadWhenIdle([b])()
      await vi.advanceTimersByTimeAsync(3000)
      expect(a.preload).toHaveBeenCalledTimes(1)
      expect(b.preload).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
})
