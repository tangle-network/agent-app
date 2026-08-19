// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ChatMessages, type ChatSelectionAction, type ChatUiMessage } from './index'

afterEach(cleanup)

const actions: ChatSelectionAction[] = [
  { id: 'ask', label: 'Ask about this' },
  { id: 'rewrite', label: 'Rewrite this' },
]

const thread: ChatUiMessage[] = [
  { id: 'u1', role: 'user', content: 'Summarize the indemnification clause.' },
  {
    id: 'a1',
    role: 'assistant',
    content: 'The clause caps liability at twelve months of fees paid.',
  },
]

/** Select the text node inside `node` and notify, the way the browser would. */
function selectWithin(node: Node) {
  const textNode = node.firstChild ?? node
  const range = document.createRange()
  range.setStart(textNode, 0)
  range.setEnd(textNode, textNode.textContent?.length ?? 0)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  // Direct dispatchEvent is not act-wrapped; without act the listener's state
  // update would not flush before the assertions.
  act(() => {
    document.dispatchEvent(new Event('selectionchange'))
  })
}

function collapseSelection() {
  window.getSelection()!.removeAllRanges()
  act(() => {
    document.dispatchEvent(new Event('selectionchange'))
  })
}

const popover = () => document.querySelector('[data-testid="selection-actions"]')

describe('ChatMessages selection actions', () => {
  it('renders no surface until text is selected', () => {
    render(
      <ChatMessages messages={thread} selectionActions={actions} onSelectionAction={() => {}} />,
    )
    expect(popover()).toBeNull()
  })

  it('keeps the transcript byte-identical when the seams are not wired', () => {
    const { container } = render(<ChatMessages messages={thread} />)
    // No scope wrapper: the first element is the message row, not a
    // positioning context; no anchor span; and a selection raises nothing.
    expect(container.firstElementChild?.className).toContain('mx-auto')
    expect(document.querySelector('[data-testid="selection-anchor"]')).toBeNull()
    const body = screen.getByText('The clause caps liability at twelve months of fees paid.')
    selectWithin(body)
    expect(popover()).toBeNull()
  })

  it('opens a portaled surface with the quote and the host actions on keyboard selection', () => {
    render(
      <ChatMessages messages={thread} selectionActions={actions} onSelectionAction={() => {}} />,
    )
    const body = screen.getByText('The clause caps liability at twelve months of fees paid.')
    selectWithin(body)

    const panel = popover()
    expect(panel).not.toBeNull()
    expect(panel!.textContent).toContain(
      '“The clause caps liability at twelve months of fees paid.”',
    )
    expect(screen.getByRole('button', { name: 'Ask about this' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Rewrite this' })).toBeTruthy()
    // The popover canon: the surface portals out of the transcript to
    // document.body, so a clipping host cannot decide its visibility.
    const surface = document.querySelector('[data-agent-app-popover]')
    expect(surface).not.toBeNull()
    expect(surface!.parentElement).toBe(document.body)
    // Keyboard reachability: focus moved into the surface on open.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Ask about this' }))
  })

  it('opens on the pointer path — after mouseup, not mid-drag', () => {
    render(
      <ChatMessages messages={thread} selectionActions={actions} onSelectionAction={() => {}} />,
    )
    const body = screen.getByText('The clause caps liability at twelve months of fees paid.')

    fireEvent.mouseDown(document.body)
    selectWithin(body) // mid-drag selectionchange: must NOT open yet
    expect(popover()).toBeNull()

    fireEvent.mouseUp(document)
    expect(popover()).not.toBeNull()
  })

  it('hands the selected text and the chosen action to the host, then closes', () => {
    const onSelectionAction = vi.fn()
    render(
      <ChatMessages messages={thread} selectionActions={actions} onSelectionAction={onSelectionAction} />,
    )
    selectWithin(screen.getByText('The clause caps liability at twelve months of fees paid.'))

    fireEvent.click(screen.getByRole('button', { name: 'Ask about this' }))
    expect(onSelectionAction).toHaveBeenCalledExactlyOnceWith(
      'The clause caps liability at twelve months of fees paid.',
      actions[0],
    )
    expect(popover()).toBeNull()
    // The passage was handed off — the selection is not left behind.
    expect(window.getSelection()!.isCollapsed).toBe(true)
  })

  it('Escape dismisses and the surface stays down until the selection changes', () => {
    render(
      <ChatMessages messages={thread} selectionActions={actions} onSelectionAction={() => {}} />,
    )
    const body = screen.getByText('The clause caps liability at twelve months of fees paid.')
    selectWithin(body)
    expect(popover()).not.toBeNull()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(popover()).toBeNull()

    // A stray selection event for the SAME selection must not resurrect it.
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(popover()).toBeNull()

    // A genuinely different selection re-opens it.
    selectWithin(screen.getByText('Summarize the indemnification clause.'))
    expect(popover()).not.toBeNull()
  })

  it('closes when the selection collapses', () => {
    render(
      <ChatMessages messages={thread} selectionActions={actions} onSelectionAction={() => {}} />,
    )
    selectWithin(screen.getByText('The clause caps liability at twelve months of fees paid.'))
    expect(popover()).not.toBeNull()
    collapseSelection()
    expect(popover()).toBeNull()
  })

  it('ignores selections outside the transcript', () => {
    render(
      <div>
        <p data-testid="outside">Text outside the transcript</p>
        <ChatMessages messages={thread} selectionActions={actions} onSelectionAction={() => {}} />
      </div>,
    )
    selectWithin(screen.getByTestId('outside'))
    expect(popover()).toBeNull()
  })

  it('renders nothing extra when actions are supplied without the callback', () => {
    render(<ChatMessages messages={thread} selectionActions={actions} />)
    selectWithin(screen.getByText('The clause caps liability at twelve months of fees paid.'))
    expect(popover()).toBeNull()
  })
})
