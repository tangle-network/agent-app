// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import {
  ChatMessages,
  sourceDomain,
  type ChatMessageFollowUp,
  type ChatMessageSource,
  type ChatUiMessage,
} from './index'

afterEach(cleanup)

const sources: ChatMessageSource[] = [
  {
    title: 'Q3 revenue report',
    url: 'https://www.example.com/reports/q3',
    faviconUrl: 'https://www.example.com/favicon.ico',
  },
  { title: 'Internal ledger export', url: 'https://ledger.corp/exports/9182' },
]

const followUps: ChatMessageFollowUp[] = [
  { id: 'fu-1', label: 'Break that down by region' },
  { id: 'fu-2', label: 'Draft the board summary' },
]

const answer: ChatUiMessage = {
  id: 'a1',
  role: 'assistant',
  content: 'Revenue grew 14% quarter over quarter, driven by the platform tier.',
  sources,
  followUps,
}

const thread: ChatUiMessage[] = [
  { id: 'u1', role: 'user', content: 'How did revenue move last quarter?' },
  answer,
]

describe('sourceDomain', () => {
  it('derives the hostname from the url and strips a www. prefix', () => {
    expect(sourceDomain({ title: 'x', url: 'https://www.example.com/a?b=1' })).toBe('example.com')
    expect(sourceDomain({ title: 'x', url: 'https://ledger.corp:8443/x' })).toBe('ledger.corp')
  })

  it('prefers an explicit domain and survives an unparseable url', () => {
    expect(sourceDomain({ title: 'x', url: 'not a url', domain: 'internal' })).toBe('internal')
    expect(sourceDomain({ title: 'x', url: 'not a url' })).toBeNull()
  })
})

describe('ChatMessages inline sources', () => {
  it('renders a source chip per source after the answer: title, derived domain, href, favicon', () => {
    render(<ChatMessages messages={thread} onFollowUpSelect={() => {}} />)
    const group = screen.getByTestId('message-sources')
    expect(group.getAttribute('aria-label')).toBe('Sources')

    const chips = group.querySelectorAll('a')
    expect(chips).toHaveLength(2)

    const first = chips[0]!
    expect(first.getAttribute('href')).toBe('https://www.example.com/reports/q3')
    expect(first.getAttribute('target')).toBe('_blank')
    expect(first.getAttribute('rel')).toContain('noreferrer')
    expect(first.textContent).toContain('Q3 revenue report')
    expect(first.textContent).toContain('example.com')
    expect(first.querySelector('img')).not.toBeNull()

    // No favicon supplied → the generic link glyph, no broken <img>.
    const second = chips[1]!
    expect(second.textContent).toContain('Internal ledger export')
    expect(second.textContent).toContain('ledger.corp')
    expect(second.querySelector('img')).toBeNull()
    expect(second.querySelector('svg')).not.toBeNull()
  })

  it('falls back to the link glyph when the favicon fails to load', () => {
    render(<ChatMessages messages={thread} onFollowUpSelect={() => {}} />)
    const img = screen.getByTestId('message-sources').querySelector('img')!
    fireEvent.error(img)
    expect(screen.getByTestId('message-sources').querySelector('img')).toBeNull()
  })

  it('renders nothing for a message without sources', () => {
    render(
      <ChatMessages
        messages={[{ id: 'a1', role: 'assistant', content: 'No provenance on this one.' }]}
      />,
    )
    expect(screen.queryByTestId('message-sources')).toBeNull()
  })

  it('does not render sources on user messages', () => {
    render(
      <ChatMessages
        messages={[{ id: 'u1', role: 'user', content: 'look at this', sources }]}
      />,
    )
    expect(screen.queryByTestId('message-sources')).toBeNull()
  })

  it('holds the chips until the turn settles — nothing renders mid-stream', () => {
    render(<ChatMessages messages={thread} loading onFollowUpSelect={() => {}} />)
    expect(screen.queryByTestId('message-sources')).toBeNull()
    expect(screen.queryByTestId('message-follow-ups')).toBeNull()
  })
})

describe('ChatMessages follow-up chips', () => {
  it('renders rounded-full chips that hand the follow-up and its message to the host', () => {
    const onFollowUpSelect = vi.fn()
    render(<ChatMessages messages={thread} onFollowUpSelect={onFollowUpSelect} />)

    const chip = screen.getByRole('button', { name: 'Break that down by region' })
    expect(chip.className).toContain('rounded-full')
    fireEvent.click(chip)
    expect(onFollowUpSelect).toHaveBeenCalledExactlyOnceWith(followUps[0], answer)
  })

  it('renders no follow-up chips when the host wired no handler', () => {
    render(<ChatMessages messages={thread} />)
    expect(screen.queryByTestId('message-follow-ups')).toBeNull()
  })
})
