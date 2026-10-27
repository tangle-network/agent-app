// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useChatScroll } from './chat-scroll'

function Transcript() {
  const scroll = useChatScroll()
  return <>
    <div data-testid="viewport" ref={scroll.viewportRef}><div ref={scroll.contentRef} /></div>
    <output>{scroll.following ? 'following' : 'paused'}</output>
    <button onClick={scroll.jumpToLatest}>Jump to latest</button>
  </>
}

function metrics(top: number, max: number) {
  const viewport = screen.getByTestId('viewport')
  Object.defineProperties(viewport, {
    scrollTop: { configurable: true, writable: true, value: top },
    scrollHeight: { configurable: true, value: max + 200 },
    clientHeight: { configurable: true, value: 200 },
  })
}

describe('useChatScroll', () => {
  afterEach(() => vi.restoreAllMocks())

  it('keeps following when content growth changes scroll metrics before resize', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(0); return 1 })
    render(<Transcript />)
    metrics(0, 0)
    fireEvent.scroll(screen.getByTestId('viewport'))
    metrics(100, 100)
    fireEvent.scroll(screen.getByTestId('viewport'))
    expect(screen.getByText('following')).toBeTruthy()

    metrics(52, 100)
    fireEvent.scroll(screen.getByTestId('viewport'))
    expect(screen.getByText('following')).toBeTruthy()
  })

  it('does not let layout shifts resume a reader who scrolled up', () => {
    render(<Transcript />)
    metrics(100, 100)
    fireEvent.wheel(screen.getByTestId('viewport'), { deltaY: -10 })
    expect(screen.getByText('paused')).toBeTruthy()

    metrics(100, 120)
    fireEvent.scroll(screen.getByTestId('viewport'))
    expect(screen.getByText('paused')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    expect(screen.getByText('following')).toBeTruthy()
    expect(screen.getByTestId('viewport').scrollTop).toBe(320)
  })

  it('resumes after an explicit downward wheel reaches the bottom', async () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(0); return 1 })
    render(<Transcript />)
    const viewport = screen.getByTestId('viewport')
    fireEvent.wheel(viewport, { deltaY: -10 })
    metrics(150, 150)
    fireEvent.wheel(viewport, { deltaY: 10 })
    await waitFor(() => expect(screen.getByText('following')).toBeTruthy())
  })
})
