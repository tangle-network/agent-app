// @vitest-environment jsdom
/**
 * The double-submit guard (`usePending` via Approve/Reject + Checkout) and the
 * top-level stream-error affordance (`ChatMessages` error row + Retry). Both
 * are correctness fixes: a slow async handler must not be re-invoked, and a
 * failed turn must surface instead of silently stopping.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ChatMessages, type ChatUiMessage, type ChatToolCallInfo } from '../../src/web-react/index'
import { SeatPaywall } from '../../src/web-react/seat-paywall'

afterEach(cleanup)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const proposalCall: ChatToolCallInfo = {
  id: 'tc-1',
  name: 'submit_proposal',
  status: 'done',
  args: { type: 'trade', title: 'Buy' },
  result: { ok: true, result: { status: 'queued_for_approval', proposalId: 'p-1' } },
}

const approvalMessages: ChatUiMessage[] = [
  { id: 'm1', role: 'assistant', content: 'here', toolCalls: [proposalCall] },
]

describe('usePending — Approve/Reject double-submit guard', () => {
  it('disables both buttons while the approve promise is in flight, then re-enables', async () => {
    const d = deferred()
    const onApprove = vi.fn(() => d.promise)
    const onReject = vi.fn()
    render(
      createElement(ChatMessages, {
        messages: approvalMessages,
        approval: { onApprove, onReject },
      }),
    )
    const approve = screen.getByRole('button', { name: /Approve/ })
    const reject = screen.getByRole('button', { name: 'Reject' })

    fireEvent.click(approve)
    expect(onApprove).toHaveBeenCalledTimes(1)
    // re-entrant clicks are swallowed while in flight
    fireEvent.click(approve)
    fireEvent.click(reject)
    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(onReject).not.toHaveBeenCalled()
    expect((approve as HTMLButtonElement).disabled).toBe(true)
    expect((reject as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      d.resolve()
      await d.promise
    })
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false))
  })

  it('a synchronous handler does not get stuck pending', () => {
    const onApprove = vi.fn()
    render(
      createElement(ChatMessages, {
        messages: approvalMessages,
        approval: { onApprove, onReject: vi.fn() },
      }),
    )
    const approve = screen.getByRole('button', { name: /Approve/ })
    fireEvent.click(approve)
    expect(onApprove).toHaveBeenCalledTimes(1)
    expect((approve as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('usePending — SeatPaywall checkout', () => {
  it('disables the CTA and ignores repeat clicks during an async checkout', async () => {
    const d = deferred()
    const onCheckout = vi.fn(() => d.promise)
    render(createElement(SeatPaywall, { product: 'Creative', onCheckout }))
    const cta = screen.getByRole('button', { name: /Unlock Creative/ })
    fireEvent.click(cta)
    fireEvent.click(cta)
    expect(onCheckout).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: /Opening checkout/ }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      d.resolve()
      await d.promise
    })
    await waitFor(() => expect(screen.getByRole('button', { name: /Unlock Creative/ })).toBeTruthy())
  })
})

describe('ChatMessages — stream-error affordance', () => {
  const messages: ChatUiMessage[] = [{ id: 'u1', role: 'user', content: 'hi' }]

  it('renders an alert row with the error and a working Retry', () => {
    const onRetry = vi.fn()
    render(createElement(ChatMessages, { messages, error: 'stream failed: HTTP 500', onRetry }))
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('stream failed: HTTP 500')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('renders the error without a Retry button when no handler is given', () => {
    render(createElement(ChatMessages, { messages, error: 'boom' }))
    expect(screen.getByRole('alert').textContent).toContain('boom')
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('suppresses the error row while a turn is still loading', () => {
    render(createElement(ChatMessages, { messages, error: 'boom', loading: true }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders no error row when error is null', () => {
    render(createElement(ChatMessages, { messages, error: null }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
