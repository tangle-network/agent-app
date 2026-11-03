// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ReviewInbox, type ReviewInboxFeedback, type ReviewInboxItem } from './review-inbox'

const items: ReviewInboxItem[] = [
  { id: 'artifact-1', revision: 'rev-1', title: 'Cold email draft', kind: 'email', createdAt: 1, canReview: true, input: {} },
]

function renderInbox(props: Partial<Parameters<typeof ReviewInbox>[0]> = {}) {
  const onVerdict = vi.fn<(item: ReviewInboxItem, decision: ReviewInboxFeedback) => Promise<void>>().mockResolvedValue(undefined)
  render(<ReviewInbox items={items} onVerdict={onVerdict} renderItem={() => <p>Draft body</p>} {...props} />)
  return onVerdict
}

async function decideApprove() {
  fireEvent.change(await screen.findByLabelText(/score/i), { target: { value: '90' } })
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
}

describe('ReviewInbox revision-bound verdicts', () => {
  it('refuses a stale row whose live revision moved, without deciding it', async () => {
    const onVerdict = renderInbox({ resolveCurrentRevision: vi.fn(async () => 'rev-2') })
    await decideApprove()
    await waitFor(() => expect(onVerdict).not.toHaveBeenCalled())
    expect(screen.getByRole('alert').textContent).toMatch(/changed after it was shown/i)
  })

  it('decides when the re-resolved revision still matches the rendered row', async () => {
    const onVerdict = renderInbox({ resolveCurrentRevision: vi.fn(async () => 'rev-1') })
    await decideApprove()
    await waitFor(() => expect(onVerdict).toHaveBeenCalledTimes(1))
  })
})
