// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ChatComposer } from './chat-composer'
import { requestWorkspacePrewarm, useWorkspacePrewarm } from './workspace-prewarm'

let visibility: DocumentVisibilityState = 'visible'
const fetchMock = vi.fn(async () => new Response('{}'))

beforeEach(() => {
  visibility = 'visible'
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// Each test uses its own URL: spacing is tab-wide state by design.
let seq = 0
const nextUrl = () => `/api/workspaces/w${++seq}/prewarm`

function Page({ url, enabled }: { url: string; enabled?: boolean }) {
  const prewarm = useWorkspacePrewarm({ url, enabled })
  return <ChatComposer onSend={() => {}} onFocusWithin={prewarm.reassert} />
}

describe('requestWorkspacePrewarm', () => {
  it('posts once and spaces repeats for the same workspace', async () => {
    const url = nextUrl()
    expect(requestWorkspacePrewarm(url)).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'POST', credentials: 'same-origin' }))
    await act(async () => {})
    expect(requestWorkspacePrewarm(url)).toBe(false)
    expect(requestWorkspacePrewarm(url, { minIntervalMs: 0 })).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not send from a hidden tab', () => {
    visibility = 'hidden'
    expect(requestWorkspacePrewarm(nextUrl())).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('swallows network failures', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    expect(requestWorkspacePrewarm(nextUrl())).toBe(true)
    await act(async () => {})
  })
})

describe('useWorkspacePrewarm', () => {
  it('fires on page open and not again on a remount of the same workspace', () => {
    const url = nextUrl()
    const first = render(<Page url={url} />)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    first.unmount()
    render(<Page url={url} />)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('waits for a background tab to become visible', () => {
    visibility = 'hidden'
    render(<Page url={nextUrl()} />)
    expect(fetchMock).not.toHaveBeenCalled()
    visibility = 'visible'
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stays quiet until enabled', () => {
    render(<Page url={nextUrl()} enabled={false} />)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('re-asserts when the composer gains focus', () => {
    visibility = 'hidden'
    render(<Page url={nextUrl()} />)
    visibility = 'visible'
    fireEvent.focusIn(screen.getByLabelText('Message input'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
