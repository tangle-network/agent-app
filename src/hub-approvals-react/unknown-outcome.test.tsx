// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { hubActionReceipt, type HubApprovalItem } from '../hub-approvals'
import { HubActionReceiptCard, HubApprovalDock, HubApprovalReceipts, HubApprovalRow, HubApprovalsList } from './index'

const UNKNOWN: HubApprovalItem = {
  id: 'message:send', actionPath: 'gmail.send', providerId: 'gmail',
  input: { to: 'ada@example.com', subject: 'Pilot terms', body: 'Hello Ada' },
  phase: 'unknown', error: 'Could not confirm whether the provider accepted the request',
  // A partial result is not evidence that the whole operation succeeded.
  result: { id: 'partial-result', url: 'https://example.com/result' },
}
const WARNING = 'Check the provider before requesting it again'

afterEach(() => vi.useRealTimers())

describe('uncertain Hub outcomes', () => {
  it('keeps uncertainty separate from confirmed failure or success in the shared receipt', () => {
    expect(hubActionReceipt(UNKNOWN)).toEqual({
      provider: { id: 'gmail', name: 'Gmail' }, status: 'unknown',
      title: 'May have run: Send email to ada@example.com', fields: [], warning: WARNING,
    })
    expect(hubActionReceipt({ ...UNKNOWN, phase: 'failed', error: 'Recipient rejected' }))
      .toMatchObject({ status: 'failed', title: 'Could not send email', error: 'Recipient rejected' })
    expect(hubActionReceipt({ ...UNKNOWN, phase: 'done' })).toMatchObject({ status: 'done', title: 'Sent email to ada@example.com' })
    expect(hubActionReceipt({ ...UNKNOWN, phase: 'denied' })).toMatchObject({ status: 'denied', title: 'Denied: Send email to ada@example.com' })
  })

  it.each(['dock', 'collapsed row', 'expanded row', 'list', 'receipt', 'summary'] as const)('server-renders a persisted unknown outcome in the %s with its warning and no retry', (surface) => {
    const item: HubApprovalItem = JSON.parse(JSON.stringify(UNKNOWN))
    const markup = renderToStaticMarkup(
      surface === 'dock' ? <HubApprovalDock items={[item]} onDecide={vi.fn()} />
        : surface === 'collapsed row' ? <HubApprovalRow item={item} actions={<button>Request again</button>} />
          : surface === 'expanded row' ? <HubApprovalRow item={item} expanded actions={<button>Request again</button>} />
            : surface === 'list' ? <HubApprovalsList items={[item]} />
              : surface === 'receipt' ? <HubActionReceiptCard item={item} />
                : <HubApprovalReceipts items={[item]} />,
    )
    expect(markup).toContain('May have run')
    expect(markup).toContain(WARNING)
    expect(markup).not.toMatch(/Failed|Could not|>Done<|>Approve<|>Deny<|Request again|>Review<|>Retry</)
    expect(markup).not.toContain('https://example.com/result')
    if (surface === 'summary') expect(markup).toContain('You approved 1 action')
  })

  it('keeps a running-to-unknown warning through reload and elapsed time without a second decision', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const onDecide = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const { rerender, unmount } = render(<HubApprovalDock items={[{ ...UNKNOWN, phase: 'waiting' }]} onDecide={onDecide} />)
    const approve = screen.getByRole('button', { name: 'Approve' })
    fireEvent.click(approve)
    fireEvent.click(approve)
    expect(onDecide).toHaveBeenCalledTimes(1)
    rerender(<HubApprovalDock items={[{ ...UNKNOWN, phase: 'running' }]} onDecide={onDecide} />)
    await act(async () => { finish() })
    rerender(<HubApprovalDock items={[UNKNOWN]} onDecide={onDecide} />)
    expect(screen.getByRole('alert').textContent).toContain(WARNING)
    act(() => vi.advanceTimersByTime(60_000))
    rerender(<HubApprovalDock items={[JSON.parse(JSON.stringify(UNKNOWN))]} onDecide={onDecide} />)
    expect(screen.getByRole('alert').textContent).toContain('May have run')
    expect(screen.queryByRole('button', { name: /approve|deny|retry|request again/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
    unmount()
    render(<HubApprovalDock items={[UNKNOWN]} onDecide={onDecide} />)
    expect(screen.getByRole('alert').textContent).toContain(WARNING)
    expect(onDecide).toHaveBeenCalledTimes(1)
  })

  it('removes a stale decision error when an unknown outcome arrives', async () => {
    const onDecide = vi.fn(async () => { throw new Error('Failed to confirm. Try again.') })
    const { rerender } = render(<HubApprovalDock items={[{ ...UNKNOWN, phase: 'waiting' }]} onDecide={onDecide} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Approve' })))
    expect(screen.getByRole('alert').textContent).toContain('Try again')
    rerender(<HubApprovalDock items={[UNKNOWN]} onDecide={onDecide} />)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain(WARNING)
    expect(screen.queryByText(/Failed|Try again/)).toBeNull()
  })

  it('allows keyboard inspection but suppresses host retry actions in an unknown row', async () => {
    const user = userEvent.setup()
    const onReview = vi.fn()
    const retry = vi.fn()
    render(<div className="overflow-hidden"><HubApprovalRow item={UNKNOWN} onReview={onReview} actions={<button onClick={retry}>Request again</button>} /></div>)
    expect(screen.getByText(WARNING)).toBeTruthy()
    await user.tab()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
    expect(screen.getByRole('article').textContent).toContain(WARNING)
    expect(screen.queryByRole('button', { name: /Review|Request again/ })).toBeNull()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy()
    expect(screen.getByText(WARNING)).toBeTruthy()
    expect(onReview).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
  })

  it('groups unknown outcomes separately and includes them in the approved count', () => {
    const onSelect = vi.fn()
    const items: HubApprovalItem[] = [UNKNOWN, { ...UNKNOWN, id: 'failure', phase: 'failed', error: 'Recipient rejected' }, { ...UNKNOWN, id: 'done', phase: 'done' }, { ...UNKNOWN, id: 'denied', phase: 'denied' }]
    const { unmount } = render(<HubApprovalsList items={items} onSelect={onSelect} />)
    const unknown = screen.getByRole('region', { name: 'May have run' })
    expect(within(unknown).getByText(WARNING)).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Failed' })).queryByText(WARNING)).toBeNull()
    expect(within(screen.getByRole('region', { name: 'Done' })).getByText('Sent email to ada@example.com')).toBeTruthy()
    fireEvent.click(within(unknown).getByRole('button'))
    expect(onSelect).toHaveBeenCalledWith(UNKNOWN)
    unmount()
    render(<HubApprovalReceipts items={items} />)
    expect(screen.getByText('You approved 3 actions and denied 1 action')).toBeTruthy()
  })
})
