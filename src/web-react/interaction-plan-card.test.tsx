// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { InteractionPlanCard } from './interaction-plan-card'
import type { InteractionSubmitResult, SubmitInteractionAnswer } from './interaction-card-support'
import type { ChatInteraction } from './chat-interactions'

afterEach(cleanup)

const PLAN_INTERACTION: ChatInteraction = {
  id: 'plan-1',
  kind: 'plan',
  title: 'Implementation plan',
  body: '## Steps\n1. Do the thing\n2. Verify the thing',
  fields: [{ type: 'text', name: 'feedback', label: 'Feedback', required: false }],
  status: 'pending',
}

function mount(
  interaction: ChatInteraction,
  props: {
    canWrite?: boolean
    submitAnswer?: SubmitInteractionAnswer
    onResolved?: (id: string, status: string) => void
    onReRequest?: () => boolean | void | Promise<boolean | void>
    reRequestLabel?: string
    renderMarkdown?: (markdown: string) => React.ReactNode
  } = {},
) {
  const submitAnswer = props.submitAnswer ?? vi.fn(async (): Promise<InteractionSubmitResult> => ({ ok: true }))
  const utils = render(
    <InteractionPlanCard
      interaction={interaction}
      canWrite={props.canWrite ?? true}
      submitAnswer={submitAnswer}
      onResolved={props.onResolved}
      onReRequest={props.onReRequest}
      reRequestLabel={props.reRequestLabel}
      renderMarkdown={props.renderMarkdown}
    />,
  )
  return { ...utils, submitAnswer }
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('InteractionPlanCard', () => {
  it('renders the plan body (plain-text fallback) with a waiting chip and expand control', () => {
    const { container } = mount(PLAN_INTERACTION)
    expect(container.textContent).toContain('Waiting for your approval')
    expect(container.textContent).toContain('Do the thing')
    const toggle = screen.getByRole('button', { name: /Show full plan/ })
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: /Collapse plan/ })).toBeTruthy()
  })

  it('renders through the injected markdown renderer', () => {
    const renderMarkdown = vi.fn((markdown: string) => <em data-testid="md">{markdown}</em>)
    mount(PLAN_INTERACTION, { renderMarkdown })
    expect(renderMarkdown).toHaveBeenCalledExactlyOnceWith(PLAN_INTERACTION.body)
    expect(screen.getByTestId('md')).toBeTruthy()
  })

  it('approves with outcome:accepted (all-optional spec approves with empty data)', async () => {
    const onResolved = vi.fn()
    const { container, submitAnswer } = mount(PLAN_INTERACTION, { onResolved })
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }))
    await flush()

    expect(submitAnswer).toHaveBeenCalledExactlyOnceWith({ id: 'plan-1', outcome: 'accepted', data: {} })
    expect(onResolved).toHaveBeenCalledWith('plan-1', 'answered')
    expect(container.textContent).toContain('Approved')
  })

  it('requests changes with outcome:declined carrying typed feedback', async () => {
    const onResolved = vi.fn()
    const { container, submitAnswer } = mount(PLAN_INTERACTION, { onResolved })
    fireEvent.change(screen.getByLabelText('Feedback'), { target: { value: 'split step 2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))
    await flush()

    expect(submitAnswer).toHaveBeenCalledExactlyOnceWith({
      id: 'plan-1',
      outcome: 'declined',
      data: { feedback: 'split step 2' },
    })
    expect(onResolved).toHaveBeenCalledWith('plan-1', 'declined')
    expect(container.textContent).toContain('Rejected')
    expect(container.textContent).toContain('The agent was asked to revise the plan.')
  })

  it('flips to expired on a 410 without a raw error', async () => {
    const submitAnswer = vi.fn(async (): Promise<InteractionSubmitResult> => ({
      ok: false,
      expired: true,
      message: 'This question is no longer waiting for an answer.',
    }))
    const onResolved = vi.fn()
    const { container } = mount(PLAN_INTERACTION, { submitAnswer, onResolved })
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }))
    await flush()

    expect(onResolved).toHaveBeenCalledWith('plan-1', 'expired')
    expect(container.textContent).toContain('Expired')
  })

  it('keeps the card approvable after a non-expired failure', async () => {
    const submitAnswer = vi.fn(async (): Promise<InteractionSubmitResult> => ({
      ok: false,
      expired: false,
      message: 'Could not reach the agent. Try again.',
    }))
    const { container } = mount(PLAN_INTERACTION, { submitAnswer })
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }))
    await flush()

    expect(container.textContent).toContain('Could not reach the agent. Try again.')
    expect((screen.getByRole('button', { name: 'Approve plan' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('disables approval for viewers', () => {
    mount(PLAN_INTERACTION, { canWrite: false })
    expect((screen.getByRole('button', { name: 'Approve plan' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Request changes' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('hides the re-request affordance entirely when onReRequest is not wired', () => {
    const { container } = mount({ ...PLAN_INTERACTION, status: 'expired' })
    expect(screen.queryByRole('button', { name: /re-submit/i })).toBeNull()
    expect(container.textContent).toContain('Expired')
  })

  it('shows and fires the re-request affordance for an expired plan', async () => {
    const onReRequest = vi.fn(() => true)
    const { container } = mount({ ...PLAN_INTERACTION, status: 'expired' }, { onReRequest })
    fireEvent.click(screen.getByRole('button', { name: 'Ask agent to re-submit the plan' }))
    await flush()

    expect(onReRequest).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /re-submit/i })).toBeNull()
    expect(container.textContent).toContain('Re-submission requested')
  })

  it('shows the re-request affordance for a cancelled plan too', async () => {
    const onReRequest = vi.fn(() => true)
    const { container } = mount({ ...PLAN_INTERACTION, status: 'cancelled' }, { onReRequest })
    fireEvent.click(screen.getByRole('button', { name: 'Ask agent to re-submit the plan' }))
    await flush()

    expect(onReRequest).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Re-submission requested')
  })

  it('keeps the re-request affordance retryable when the send is rejected', async () => {
    const { container } = mount({ ...PLAN_INTERACTION, status: 'expired' }, { onReRequest: () => false })
    fireEvent.click(screen.getByRole('button', { name: 'Ask agent to re-submit the plan' }))
    await flush()

    expect(container.textContent).toContain('The re-request was not sent. Try again.')
    expect(container.textContent).not.toContain('Re-submission requested')
    expect((screen.getByRole('button', { name: 'Ask agent to re-submit the plan' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('hides the re-request affordance for viewers even when onReRequest is wired', () => {
    mount({ ...PLAN_INTERACTION, status: 'expired' }, { canWrite: false, onReRequest: () => true })
    expect(screen.queryByRole('button', { name: /re-submit/i })).toBeNull()
  })

  it('honors a custom reRequestLabel', () => {
    mount({ ...PLAN_INTERACTION, status: 'expired' }, { onReRequest: () => true, reRequestLabel: 'Try the plan again' })
    expect(screen.getByRole('button', { name: 'Try the plan again' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Ask agent to re-submit the plan' })).toBeNull()
  })

  it('shows Asking… and disables the button while the re-request is in flight', async () => {
    let resolve!: (value: boolean) => void
    const onReRequest = vi.fn(() => new Promise<boolean>((res) => { resolve = res }))
    mount({ ...PLAN_INTERACTION, status: 'expired' }, { onReRequest })
    fireEvent.click(screen.getByRole('button', { name: 'Ask agent to re-submit the plan' }))
    await flush()

    const button = screen.getByRole('button', { name: 'Asking…' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)

    await act(async () => {
      resolve(true)
      await Promise.resolve()
    })
  })
})
