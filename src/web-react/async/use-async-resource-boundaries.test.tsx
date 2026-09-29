// @vitest-environment jsdom
import { StrictMode, createElement, type PropsWithChildren } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useAsyncResource } from './use-async-resource'

const never = <T,>() => new Promise<T>(() => {})

describe('resource identity at render boundaries', () => {
  it('immediately removes a loaded value when disabled', async () => {
    const load = vi.fn(async () => 'workspace-a')
    const { result, rerender } = renderHook(({ enabled }) => useAsyncResource({ load, enabled }), {
      initialProps: { enabled: true },
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    rerender({ enabled: false })
    expect(result.current.status).toBe('idle')
    expect(result.current).not.toHaveProperty('value')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it.each(['ready', 'error'] as const)('does not publish another identity\'s %s state for even one render', async kind => {
    const renders: Array<{ key: string; status: string; value?: unknown }> = []
    const { result, rerender } = renderHook(({ key }) => {
      const resource = useAsyncResource({
        deps: [key],
        load: async () => {
          if (key === 'b') return never<string>()
          if (kind === 'error') throw new Error('workspace-a error')
          return 'workspace-a'
        },
      })
      renders.push({ key, status: resource.status, ...('value' in resource ? { value: resource.value } : {}) })
      return resource
    }, { initialProps: { key: 'a' } })
    await waitFor(() => expect(result.current.status).toBe(kind))
    rerender({ key: 'b' })
    expect(renders.filter(row => row.key === 'b').every(row => row.status === 'loading')).toBe(true)
  })

  it('retains an initial value through React StrictMode effect replay without an unnecessary request', () => {
    const load = vi.fn(() => never<string>())
    const { result } = renderHook(() => useAsyncResource({ load, initialValue: 'server-seed' }), {
      wrapper: ({ children }: PropsWithChildren) => createElement(StrictMode, null, children),
    })
    expect(result.current).toMatchObject({ status: 'ready', value: 'server-seed' })
    expect(load).not.toHaveBeenCalled()
  })

  it('a disabled initial value cannot escape as ready data', () => {
    const load = vi.fn(() => never<string>())
    const { result } = renderHook(() => useAsyncResource({ enabled: false, initialValue: 'server-seed', load }))
    expect(result.current.status).toBe('idle')
    expect(result.current).not.toHaveProperty('value')
    expect(load).not.toHaveBeenCalled()
  })

  it('retry invalidates the old resolution before the next effect', async () => {
    const renders: string[] = []
    let attempt = 0
    const { result } = renderHook(() => {
      const resource = useAsyncResource({ load: async () => ++attempt === 1 ? 'old' : never<string>() })
      renders.push(resource.status)
      return resource
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    renders.length = 0
    act(() => result.current.retry())
    expect(renders.length).toBeGreaterThan(0)
    expect(renders.every(status => status === 'loading')).toBe(true)
  })

  it('compares dependency values even when the caller reuses the array object', async () => {
    const deps = ['a']
    const load = vi.fn(async () => deps[0])
    const { result, rerender } = renderHook(() => useAsyncResource({ load, deps }))
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', value: 'a' }))
    deps[0] = 'b'
    rerender()
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', value: 'b' }))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('reenabling the same dependency loads afresh rather than reviving a disabled result', async () => {
    let value = 'old'
    const load = vi.fn(async () => value)
    const renders: Array<{ enabled: boolean; status: string; value?: unknown }> = []
    const { result, rerender } = renderHook(({ enabled }) => {
      const resource = useAsyncResource({ load, deps: ['same-workspace'], enabled })
      renders.push({ enabled, status: resource.status, ...('value' in resource ? { value: resource.value } : {}) })
      return resource
    }, { initialProps: { enabled: true } })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    rerender({ enabled: false })
    value = 'new'
    renders.length = 0
    rerender({ enabled: true })
    expect(renders[0]).toEqual({ enabled: true, status: 'loading' })
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', value: 'new' }))
  })
})
