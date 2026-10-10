// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HubApprovalItem } from '../hub-approvals'
import { HubActionReceiptCard, HubApprovalDock, HubApprovalReceipts, HubApprovalRow, HubApprovalsList } from './index'

const PROPOSE: HubApprovalItem = {
  id: 'm1:call_1',
  actionPath: 'github.pulls.propose',
  providerId: 'github',
  account: 'octocat',
  phase: 'waiting',
  requestedAt: '2026-10-09T20:00:00Z',
  expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
  input: {
    owner: 'acme', repo: 'site', base: 'main', branch: 'gtm-agent/hero', title: 'Fix the hero wrap',
    files: [{ path: 'src/routes/_index.tsx', content: 'x' }],
  },
  files: [{ path: 'src/routes/_index.tsx', change: 'modified', additions: 4, deletions: 2 }],
}

const EMAIL: HubApprovalItem = {
  id: 'm1:call_2', actionPath: 'gmail.send', providerId: 'gmail', phase: 'waiting', account: 'ops@acme.com',
  input: { to: ['ada@acme.com'], subject: 'Pilot terms', body: '<p>Hello <b>Ada</b></p>', html: true },
}

afterEach(() => vi.useRealTimers())

describe('HubApprovalDock', () => {
  it('shows what the call does, where, as which account, and its integration preview', () => {
    render(<HubApprovalDock items={[PROPOSE]} onDecide={vi.fn()} />)
    const dock = screen.getByRole('region', { name: 'Waiting for your approval' })
    expect(within(dock).getByRole('heading', { name: 'Open PR: Fix the hero wrap on acme/site' })).toBeTruthy()
    expect(within(dock).getByText(/GitHub · as octocat · closes in 3 h/)).toBeTruthy()
    expect(within(dock).getByText('gtm-agent/hero')).toBeTruthy()
    expect(within(dock).getByText('src/routes/_index.tsx')).toBeTruthy()
    expect(within(dock).getAllByText('+4').length).toBeGreaterThan(0)
  })

  it('says why a call waits for the owner, and which calls run on their own', () => {
    const post: HubApprovalItem = {
      id: 'm1:call_3', actionPath: 'twitter.tweets.create', providerId: 'twitter', phase: 'waiting', input: { text: 'Ship it' },
      wait: { owner: true, code: 'daily_cap', reason: 'Autopilot already published 3 posts today, its daily limit.' },
    }
    const speech: HubApprovalItem = {
      id: 'm1:call_4', actionPath: 'phony.synthesize_speech', providerId: 'phony', phase: 'waiting', input: { text: 'Hi' },
      wait: { owner: false, code: 'thread_auto', reason: 'Runs when the reply finishes, under this conversation’s auto-approve.' },
    }
    render(<HubApprovalDock items={[post, speech]} onDecide={vi.fn()} permissions={() => ({ never: 'Publishing always needs your approval.' })} />)
    const dock = screen.getByRole('region', { name: 'Waiting for your approval' })
    expect(within(dock).getByText('Autopilot already published 3 posts today, its daily limit.')).toBeTruthy()
    // The host's reason replaces the generic never-grantable line.
    expect(within(dock).queryByText('Publishing always needs your approval.')).toBeNull()
    fireEvent.click(within(dock).getByRole('button', { name: /Create voice memo|synthesize/i }))
    expect(within(dock).getByText('Runs when the reply finishes, under this conversation’s auto-approve.')).toBeTruthy()

    render(<HubApprovalsList items={[post, speech]} />)
    const list = screen.getByRole('region', { name: 'Waiting' })
    expect(within(list).getByText('Runs on its own')).toBeTruthy()
    expect(within(list).getByText('Autopilot already published 3 posts today, its daily limit.')).toBeTruthy()
  })

  it('renders an HTML email as text, never markup', () => {
    render(<HubApprovalDock items={[EMAIL]} onDecide={vi.fn()} />)
    expect(screen.getByText('Hello Ada')).toBeTruthy()
    expect(screen.getByText('ops@acme.com')).toBeTruthy()
    expect(document.querySelector('b')).toBeNull()
  })

  it('sends the decision and shows the run in place until the host reports the result', async () => {
    let finish!: () => void
    const onDecide = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const { rerender } = render(<HubApprovalDock items={[PROPOSE]} onDecide={onDecide} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onDecide).toHaveBeenCalledWith(PROPOSE, { kind: 'approve' })
    expect(screen.getByRole('status').textContent).toContain('Approving…')
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()

    rerender(<HubApprovalDock items={[{ ...PROPOSE, phase: 'running' }]} onDecide={onDecide} />)
    expect(screen.getByRole('status').textContent).toContain('Running on GitHub…')

    await act(async () => { finish() })
    rerender(<HubApprovalDock items={[{
      ...PROPOSE, phase: 'done',
      result: { pullRequest: { number: 7, url: 'https://github.com/acme/site/pull/7' } },
    }]} onDecide={onDecide} />)
    const link = screen.getByRole('link', { name: /Opened PR #7/ })
    expect(link.getAttribute('href')).toBe('https://github.com/acme/site/pull/7')
  })

  it('lets a finished call leave the dock after its result has been seen', () => {
    vi.useFakeTimers()
    const { rerender, container } = render(<HubApprovalDock items={[{ ...PROPOSE, phase: 'running' }]} onDecide={vi.fn()} />)
    rerender(<HubApprovalDock items={[{ ...PROPOSE, phase: 'done', result: {} }]} onDecide={vi.fn()} />)
    expect(screen.getByText('Opened pull request')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(6_500) })
    expect(container.querySelector('[data-hub-approval-dock]')).toBeNull()
  })

  it('keeps a failed call until it is dismissed, with the reason', () => {
    const { rerender, container } = render(<HubApprovalDock items={[{ ...PROPOSE, phase: 'running' }]} onDecide={vi.fn()} />)
    rerender(<HubApprovalDock items={[{ ...PROPOSE, phase: 'failed', error: 'Branch gtm-agent/hero already exists' }]} onDecide={vi.fn()} />)
    expect(screen.getByRole('alert').textContent).toBe('Could not open pull request: Branch gtm-agent/hero already exists')
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }))
    expect(container.querySelector('[data-hub-approval-dock]')).toBeNull()
  })

  it('reports a decision the host refused and keeps the call decidable', async () => {
    const onDecide = vi.fn(async () => { throw new Error('This approval request expired before a decision.') })
    render(<HubApprovalDock items={[PROPOSE]} onDecide={onDecide} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Deny' })) })
    expect(onDecide).toHaveBeenCalledWith(PROPOSE, { kind: 'deny' })
    expect(screen.getByRole('alert').textContent).toBe('This approval request expired before a decision.')
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
  })

  it('offers the host’s standing permissions with the chosen scope, or says why none apply', () => {
    const onDecide = vi.fn(async () => {})
    const { unmount } = render(
      <HubApprovalDock
        items={[PROPOSE]}
        onDecide={onDecide}
        permissions={() => ({ scopes: [{ id: 'narrow', label: 'Only in acme/site' }, { id: 'action', label: 'Any pull request' }] })}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Allow future calls…' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Any pull request' }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve and allow for 24 hours' }))
    expect(onDecide).toHaveBeenCalledWith(PROPOSE, { kind: 'allow', duration: '24h', scope: 'action' })
    unmount()

    render(<HubApprovalDock items={[EMAIL]} onDecide={vi.fn()} permissions={() => ({ never: 'Sending email always asks.' })} />)
    expect(screen.queryByRole('button', { name: 'Allow future calls…' })).toBeNull()
    expect(screen.getByText('Sending email always asks.')).toBeTruthy()
  })

  it('lists every waiting call above the open one, opens the one picked, and brings a focused one to the front', () => {
    const { rerender } = render(<HubApprovalDock items={[PROPOSE, EMAIL]} onDecide={vi.fn()} />)
    const list = screen.getByRole('list', { name: 'Requests in this conversation' })
    expect(within(list).getAllByRole('button').map((row) => row.textContent)).toEqual([
      'Open PR: Fix the hero wrap on acme/siteWaiting', 'Send email to ada@acme.comWaiting',
    ])
    expect(screen.getByText('2 requests waiting')).toBeTruthy()
    fireEvent.click(within(list).getByRole('button', { name: /Send email to ada@acme.com/ }))
    expect(screen.getByRole('heading', { name: 'Send email to ada@acme.com' })).toBeTruthy()
    expect(within(list).getByRole('button', { name: /Send email/ }).getAttribute('aria-current')).toBe('true')
    rerender(<HubApprovalDock items={[PROPOSE, EMAIL]} onDecide={vi.fn()} focusId={PROPOSE.id} />)
    expect(screen.getByRole('heading', { name: 'Open PR: Fix the hero wrap on acme/site' })).toBeTruthy()
  })

  it('names the account only when it adds to the provider', () => {
    const { rerender } = render(<HubApprovalDock items={[{ ...PROPOSE, account: 'GitHub' }]} onDecide={vi.fn()} />)
    expect(screen.getByText(/^GitHub · closes in/)).toBeTruthy()
    rerender(<HubApprovalDock items={[PROPOSE]} onDecide={vi.fn()} />)
    expect(screen.getByText(/^GitHub · as octocat · closes in/)).toBeTruthy()
  })

  it('shows nothing when no call waits, and no buttons to someone who cannot decide', () => {
    const { container, rerender } = render(<HubApprovalDock items={[{ ...PROPOSE, phase: 'done' }]} onDecide={vi.fn()} />)
    expect(container.innerHTML).toBe('')
    rerender(<HubApprovalDock items={[{ ...PROPOSE, phase: 'blocked' }]} onDecide={vi.fn()} />)
    expect(screen.getByText('The workspace owner approves this request.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })
})

describe('HubApprovalsList', () => {
  it('groups calls by where they stand and hands a picked one to the host', () => {
    const onSelect = vi.fn()
    render(<HubApprovalsList
      items={[PROPOSE, { ...EMAIL, phase: 'done', result: { id: 'x' } }, { ...EMAIL, id: 'm2:call_3', phase: 'failed', error: 'no' }]}
      onSelect={onSelect}
    />)
    expect(screen.getByText('1 request is waiting')).toBeTruthy()
    const waiting = screen.getByRole('region', { name: 'Waiting' })
    expect(within(waiting).getByText('Open PR: Fix the hero wrap on acme/site')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Done' })).getByText('Sent email to ada@acme.com')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Failed' })).getByText('Send email to ada@acme.com')).toBeTruthy()
    fireEvent.click(within(waiting).getByRole('button'))
    expect(onSelect).toHaveBeenCalledWith(PROPOSE)
  })

  it('says when a conversation has no approvals', () => {
    render(<HubApprovalsList items={[]} />)
    expect(screen.getByText('No approvals in this conversation')).toBeTruthy()
  })
})

describe('receipts and rows', () => {
  it('stands in for the resume message with receipts and keeps that message behind Details', () => {
    render(<HubApprovalReceipts
      items={[{ ...PROPOSE, phase: 'done', result: { pullRequest: { number: 7, url: 'https://github.com/acme/site/pull/7' }, branch: 'gtm-agent/hero', base: 'main' } }, { ...EMAIL, phase: 'denied' }]}
      message="I decided the Hub actions you requested: …"
      at="2026-10-09T20:05:00Z"
    />)
    expect(screen.getByText('You approved 1 action and denied 1 action')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Opened PR #7/ })).toBeTruthy()
    expect(screen.getByText('Denied: Send email to ada@acme.com')).toBeTruthy()
    expect(screen.queryByText(/I decided the Hub actions/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Message sent to the agent' }))
    expect(screen.getByText(/I decided the Hub actions/)).toBeTruthy()
  })

  it('plays a voice memo result', () => {
    render(<HubActionReceiptCard item={{
      id: 'a', actionPath: 'phony.synthesize_speech', providerId: 'phony', phase: 'done', input: { text: 'hi' },
      result: { audioUrl: 'https://audio.example/a.mp3', durationSeconds: 2 },
    }} />)
    expect(document.querySelector('audio')?.getAttribute('src')).toBe('https://audio.example/a.mp3')
    expect(screen.getByText('Created voice memo')).toBeTruthy()
  })

  it('marks a call where the agent made it and opens its detail', () => {
    const onReview = vi.fn()
    render(<HubApprovalRow item={PROPOSE} onReview={onReview} />)
    expect(screen.getByText('Waiting')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(onReview).toHaveBeenCalledWith(PROPOSE)
    expect(screen.queryByText('src/routes/_index.tsx')).toBeNull()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('src/routes/_index.tsx')).toBeTruthy()
  })
})
