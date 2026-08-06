// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ChatMessages, type ChatUiMessage } from './index'

afterEach(cleanup)

const thread: ChatUiMessage[] = [
  { id: 'u1', role: 'user', content: 'Render the launch poster.' },
  {
    id: 'a1',
    role: 'assistant',
    content: 'Poster rendered and queued for review.',
    modelUsed: 'anthropic/claude-opus-4',
    promptTokens: 1000,
    completionTokens: 200,
    durationMs: 4000,
  },
]

describe('ChatMessages quiet chrome', () => {
  it('renders no role labels in quiet mode', () => {
    const { queryByText } = render(<ChatMessages messages={thread} chrome="quiet" />)
    expect(queryByText('User')).toBeNull()
    expect(queryByText('Agent')).toBeNull()
  })

  it('renders one hover-revealed meta lane per row, carrying the demoted meta', () => {
    const { getAllByTestId } = render(<ChatMessages messages={thread} chrome="quiet" />)
    const lanes = getAllByTestId('message-meta-lane')
    expect(lanes).toHaveLength(thread.length)

    // Zero layout shift: the lane always reserves its fixed height and reveals
    // on row hover via opacity, never by mounting/unmounting.
    for (const lane of lanes) {
      expect(lane.className).toContain('h-[18px]')
      expect(lane.className).toContain('opacity-0')
      expect(lane.className).toContain('group-hover:opacity-100')
    }

    // The user lane carries only the copy affordance; the assistant lane
    // demotes the model/tok-s/cost meta that labeled mode shows up top.
    expect(lanes[0]?.textContent).not.toContain('anthropic/claude-opus-4')
    expect(lanes[1]?.textContent).toContain('anthropic/claude-opus-4')
    expect(lanes[1]?.textContent).toContain('50 tok/s')
  })

  it('copies the message text to the clipboard from the lane button', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    render(<ChatMessages messages={thread} chrome="quiet" />)
    const copyButtons = screen.getAllByLabelText('Copy message')
    expect(copyButtons).toHaveLength(thread.length)

    fireEvent.click(copyButtons[0] as HTMLElement)
    expect(writeText).toHaveBeenCalledExactlyOnceWith('Render the launch poster.')

    fireEvent.click(copyButtons[1] as HTMLElement)
    expect(writeText).toHaveBeenLastCalledWith('Poster rendered and queued for review.')
  })

  it('keeps the labeled chrome byte-identical by default (labels on, no lane)', () => {
    const { getByText, queryByTestId, queryByLabelText, container } = render(
      <ChatMessages messages={thread} />,
    )
    expect(getByText('User')).toBeTruthy()
    expect(getByText('Agent')).toBeTruthy()
    // The labeled meta line still carries the model id up top.
    expect(getByText('anthropic/claude-opus-4')).toBeTruthy()
    // No quiet-only affordances leak into the default.
    expect(queryByTestId('message-meta-lane')).toBeNull()
    expect(queryByLabelText('Copy message')).toBeNull()
    // The user bubble stays primary-tinted and asymmetric.
    expect(container.innerHTML).toContain('bg-primary/10')
    expect(container.innerHTML).toContain('rounded-tr-md')
  })
})
