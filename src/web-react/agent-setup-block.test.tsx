// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentSetupBlock } from './agent-setup-block'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubClipboard(writeText: (text: string) => Promise<void>) {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
}

describe('AgentSetupBlock', () => {
  it('copies the exact setup skill it is given and links the raw prompt', async () => {
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
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Copied. Paste it into your coding agent.')
    expect(writeText).toHaveBeenCalledWith('---\nname: tangle-widget-setup\n---\n# Set up')
  })

  it('falls back to a fetch instruction without the text and explains a blocked clipboard', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied')
    })
    stubClipboard(writeText)
    render(<AgentSetupBlock productName="Tangle Widget" setupUrl="https://widget.tangle.tools/agent-setup.md" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy setup prompt' }))
    expect((await screen.findByRole('status')).textContent).toBe(
      'Clipboard unavailable. Open https://widget.tangle.tools/agent-setup.md and copy it from there.',
    )
    expect(writeText).toHaveBeenCalledWith(
      'Set up Tangle Widget for me. Fetch https://widget.tangle.tools/agent-setup.md and follow every step in it.',
    )
  })
})
