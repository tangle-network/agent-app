// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentSetupBlock } from './agent-setup-block'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function stubClipboard(writeText: (text: string) => Promise<void>) {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
}

describe('AgentSetupBlock', () => {
  it('lets a manual-key product state its actual setup authority', () => {
    render(<AgentSetupBlock productName="Workspace" setupUrl="https://app.example/agent-setup.md" description="The owner issues a scoped key; the agent cannot authorize spending." />)
    expect(screen.getByText('The owner issues a scoped key; the agent cannot authorize spending.')).toBeTruthy()
    expect(screen.queryByText(/gets its own capped key/)).toBeNull()
  })

  it('copies the exact setup skill and shows an accessible Copied button with a check', async () => {
    const writeText = vi.fn(async () => {})
    stubClipboard(writeText)
    render(
      <AgentSetupBlock
        productName="Tangle Widget"
        setupUrl="https://widget.tangle.tools/agent-setup.md"
        markdown={'---\nname: tangle-widget-setup\n---\n# Set up'}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Hand this to your agent' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'https://widget.tangle.tools/agent-setup.md' }).getAttribute('href')).toBe(
      'https://widget.tangle.tools/agent-setup.md',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy setup prompt' }))
    const copiedButton = await screen.findByRole('button', { name: 'Copied' })
    expect(copiedButton.querySelector('svg')).not.toBeNull()
    expect(screen.getByRole('status')).toHaveProperty('textContent', 'Copied. Paste it into your coding agent.')
    expect(writeText).toHaveBeenCalledWith('---\nname: tangle-widget-setup\n---\n# Set up')
  })

  it('resets the button after the copied confirmation timeout', async () => {
    vi.useFakeTimers()
    stubClipboard(vi.fn(async () => {}))
    render(<AgentSetupBlock productName="Tangle Widget" setupUrl="https://widget.tangle.tools/agent-setup.md" />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy setup prompt' }))
    })
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByRole('button', { name: 'Copy setup prompt' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
  })

  it('clears the copied confirmation timer on unmount', async () => {
    vi.useFakeTimers()
    stubClipboard(vi.fn(async () => {}))
    const { unmount } = render(<AgentSetupBlock productName="Tangle Widget" setupUrl="https://widget.tangle.tools/agent-setup.md" />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy setup prompt' }))
    })
    expect(vi.getTimerCount()).toBe(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('falls back to a fetch instruction and never claims a blocked clipboard was copied', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied')
    })
    stubClipboard(writeText)
    render(<AgentSetupBlock productName="Tangle Widget" setupUrl="https://widget.tangle.tools/agent-setup.md" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy setup prompt' }))
    expect((await screen.findByRole('status')).textContent).toBe(
      'Clipboard unavailable. Open https://widget.tangle.tools/agent-setup.md and copy it from there.',
    )
    expect(screen.getByRole('button', { name: 'Copy setup prompt' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
    expect(writeText).toHaveBeenCalledWith(
      'Set up Tangle Widget for me. Fetch https://widget.tangle.tools/agent-setup.md and follow every step in it.',
    )
  })
})
