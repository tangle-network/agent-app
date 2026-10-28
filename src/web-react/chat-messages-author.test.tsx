// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { ChatMessages, type ChatMessagesProps, type ChatUiMessage } from './index'

afterEach(cleanup)

const twoParty: ChatUiMessage[] = [
  { id: 'u1', role: 'user', content: 'Can I break my lease early?' },
  {
    id: 'a1',
    role: 'assistant',
    content: 'It depends on the lease terms.',
    modelUsed: 'anthropic/claude-opus-4',
  },
]

function html(props: ChatMessagesProps): string {
  const markup = render(<ChatMessages {...props} />).container.innerHTML
  cleanup()
  return markup
}

const client = { id: 'client-maria', name: 'Maria Lopez', role: 'Client' }
const attorney = { id: 'attorney-jane', name: 'Jane Doe', role: 'Attorney' }
const agent = { id: 'agent-intake', name: 'Intake assistant', role: 'AI' }

const threeParty: ChatUiMessage[] = [
  { id: 'm1', role: 'user', author: client, content: 'My landlord kept my deposit.' },
  {
    id: 'm2',
    role: 'assistant',
    author: agent,
    content: 'I shared your summary with Jane Doe.',
    modelUsed: 'anthropic/claude-opus-4',
  },
  { id: 'm3', role: 'user', author: attorney, content: 'Did you give a forwarding address?' },
]

/** The bubble that holds a message's text. */
const bubbleOf = (text: string) => screen.getByText(text).parentElement as HTMLElement

describe('a viewerId without authors', () => {
  it('changes nothing in either chrome', () => {
    expect(html({ messages: twoParty, viewerId: 'client-maria' })).toBe(html({ messages: twoParty }))
    expect(html({ messages: twoParty, chrome: 'quiet', viewerId: 'client-maria' })).toBe(
      html({ messages: twoParty, chrome: 'quiet' }),
    )
  })
})

describe('ChatMessages with authors', () => {
  it("renders the reader's own message exactly as an unauthored one", () => {
    const own: ChatUiMessage = { id: 'u1', role: 'user', author: client, content: 'Can I break my lease early?' }
    for (const chrome of ['labeled', 'quiet'] as const) {
      expect(html({ messages: [own], viewerId: client.id, chrome })).toBe(
        html({ messages: [{ id: 'u1', role: 'user', content: 'Can I break my lease early?' }], chrome }),
      )
    }
  })

  it("puts someone else's message at the start, on a card, under their name and role", () => {
    render(<ChatMessages messages={threeParty} viewerId={client.id} />)
    const theirs = bubbleOf('Did you give a forwarding address?')
    expect(theirs.className).toContain('bg-[hsl(var(--card))]')
    expect(theirs.className).not.toContain('bg-[hsl(var(--foreground))]')
    expect(theirs.parentElement?.className).not.toContain('ml-auto')
    expect(screen.getByText('Jane Doe')).toBeTruthy()
    expect(screen.getByText('Attorney')).toBeTruthy()
    // The reader is not named; their bubble keeps the inverse fill and label.
    expect(screen.queryByText('Maria Lopez')).toBeNull()
    expect(bubbleOf('My landlord kept my deposit.').className).toContain('bg-[hsl(var(--foreground))]')
    expect(screen.getAllByText('User')).toHaveLength(1)
  })

  it("mirrors the thread on the attorney's screen", () => {
    render(<ChatMessages messages={threeParty} viewerId={attorney.id} />)
    expect(bubbleOf('Did you give a forwarding address?').className).toContain('bg-[hsl(var(--foreground))]')
    expect(bubbleOf('My landlord kept my deposit.').className).toContain('bg-[hsl(var(--card))]')
    expect(screen.getByText('Maria Lopez')).toBeTruthy()
    expect(screen.queryByText('Jane Doe')).toBeNull()
  })

  it('names the agent in place of the agent label and keeps its model meta', () => {
    render(<ChatMessages messages={threeParty} viewerId={client.id} />)
    expect(screen.queryByText('Agent')).toBeNull()
    expect(screen.getByText('Intake assistant')).toBeTruthy()
    expect(screen.getByText('anthropic/claude-opus-4')).toBeTruthy()
  })

  it('names everyone but the reader in quiet chrome, with the copy lane on their side', () => {
    render(<ChatMessages messages={threeParty} viewerId={client.id} chrome="quiet" />)
    expect(screen.getByText('Jane Doe')).toBeTruthy()
    expect(screen.getByText('Intake assistant')).toBeTruthy()
    expect(screen.queryByText('Maria Lopez')).toBeNull()
    const lanes = screen.getAllByTestId('message-meta-lane')
    expect(lanes).toHaveLength(threeParty.length)
    expect(lanes[0]?.className).toContain('justify-end')
    expect(lanes[2]?.className).toContain('justify-start')
  })
})
