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

// Recorded from `ChatMessages` before `author` existed. A thread that names no
// author must keep this exact markup in both chromes.
describe('a thread without authors', () => {
  it('renders the labeled chrome as before', () => {
    expect(html({ messages: twoParty })).toMatchInlineSnapshot(`"<div class="mx-auto w-full max-w-3xl px-6 py-3"><div class="ml-auto w-fit max-w-[85%]"><p class="mb-1 text-right text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">User</p><div class="rounded-2xl bg-[hsl(var(--foreground))] px-4 py-2.5 text-[hsl(var(--background))] rounded-tr-md agent-app-message-copy text-base leading-[1.6]"><p class="whitespace-pre-wrap">Can I break my lease early?</p></div></div></div><div class="mx-auto w-full max-w-3xl px-6 py-3"><div class="mb-1 flex items-baseline gap-2 text-xs tabular-nums text-muted-foreground"><span class="font-semibold uppercase tracking-[0.05em]">Agent</span><span class="font-mono normal-case">anthropic/claude-opus-4</span></div><div class="agent-app-message-copy text-base leading-[1.6] bg-transparent text-[hsl(var(--foreground))]"><p class="whitespace-pre-wrap">It depends on the lease terms.</p></div></div>"`)
  })

  it('renders the quiet chrome as before', () => {
    expect(html({ messages: twoParty, chrome: 'quiet' })).toMatchInlineSnapshot(`"<div class="mx-auto w-full max-w-3xl px-6 group pb-1 pt-3"><div class="ml-auto w-fit max-w-[72%]"><div class="rounded-2xl bg-[hsl(var(--foreground))] px-4 py-2.5 text-[hsl(var(--background))] agent-app-message-copy text-base leading-[1.6]"><p class="whitespace-pre-wrap">Can I break my lease early?</p></div></div><div data-testid="message-meta-lane" class="mt-1 flex h-[18px] items-center gap-2 text-xs tabular-nums text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100 justify-end"><button type="button" aria-label="Copy message" title="Copy message" class="rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"><svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button></div></div><div class="mx-auto w-full max-w-3xl px-6 group pb-1 pt-3"><div class="agent-app-message-copy text-base leading-[1.6] bg-transparent text-[hsl(var(--foreground))]"><p class="whitespace-pre-wrap">It depends on the lease terms.</p></div><div data-testid="message-meta-lane" class="mt-1 flex h-[18px] items-center gap-2 text-xs tabular-nums text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100"><button type="button" aria-label="Copy message" title="Copy message" class="rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"><svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button><span class="font-mono">anthropic/claude-opus-4</span></div></div>"`)
  })
})

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
