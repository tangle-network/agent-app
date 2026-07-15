// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { InteractionQuestionCard } from './interaction-question-card'
import {
  createInteractionAnswerSubmitter,
  type InteractionSubmitResult,
  type SubmitInteractionAnswer,
} from './interaction-card-support'
import type { ChatInteraction } from './chat-interactions'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const SELECT_INTERACTION: ChatInteraction = {
  id: 'int-1',
  kind: 'question',
  title: 'Which tone do you prefer?',
  fields: [{
    type: 'select',
    name: 'q0',
    label: 'Which tone do you prefer?',
    required: true,
    multi: false,
    options: [
      { value: 'Formal', label: 'Formal', description: 'Board-deck voice.' },
      { value: 'Casual', label: 'Casual' },
    ],
  }],
  status: 'pending',
}

const TEXT_INTERACTION: ChatInteraction = {
  id: 'int-2',
  kind: 'question',
  title: 'Describe your audience',
  fields: [{ type: 'text', name: 'q0', label: 'Describe your audience', required: true }],
  status: 'pending',
}

const SECRET_INTERACTION: ChatInteraction = {
  id: 'int-secret',
  kind: 'question',
  title: 'Paste the API key',
  fields: [{ type: 'secret', name: 'apiKey', label: 'API key', required: true }],
  status: 'cancelled',
}

function okSubmitter(): SubmitInteractionAnswer & ReturnType<typeof vi.fn> {
  return vi.fn(async (): Promise<InteractionSubmitResult> => ({ ok: true }))
}

function mount(
  interaction: ChatInteraction,
  props: {
    canWrite?: boolean
    submitAnswer?: SubmitInteractionAnswer
    onResolved?: (id: string, status: string) => void
    onLateAnswer?: (message: string) => boolean | void | Promise<boolean | void>
  } = {},
) {
  const submitAnswer = props.submitAnswer ?? okSubmitter()
  const utils = render(
    <InteractionQuestionCard
      interaction={interaction}
      canWrite={props.canWrite ?? true}
      submitAnswer={submitAnswer}
      onResolved={props.onResolved}
      onLateAnswer={props.onLateAnswer}
    />,
  )
  return { ...utils, submitAnswer }
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Submit answer|Submitting…/ }) as HTMLButtonElement
}

function lateAnswerButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Send as new message|Sending…/ }) as HTMLButtonElement
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('InteractionQuestionCard', () => {
  it('renders answerSpec fields with a waiting status chip', () => {
    const { container } = mount(SELECT_INTERACTION)
    expect(container.textContent).toContain('Waiting for your answer')
    expect(container.textContent).toContain('Formal')
    expect(container.textContent).toContain('Board-deck voice.')
    expect(container.textContent).toContain('Casual')
  })

  it('shows the write-in row only when the field grants allowCustom', () => {
    const { container, unmount } = mount(SELECT_INTERACTION)
    expect(container.querySelector('input[type="text"]')).toBeNull()
    unmount()

    const withCustom = mount({
      ...SELECT_INTERACTION,
      id: 'int-custom',
      fields: [{ ...SELECT_INTERACTION.fields[0], allowCustom: true } as ChatInteraction['fields'][number]],
    })
    expect(withCustom.container.querySelector('input[type="text"]')).not.toBeNull()
  })

  it('submits a select answer as { q0: [value] } and resolves the card', async () => {
    const onResolved = vi.fn()
    const { container, submitAnswer } = mount(SELECT_INTERACTION, { onResolved })
    fireEvent.click(screen.getByLabelText('Formal'))
    fireEvent.click(submitButton())
    await flush()

    expect(submitAnswer).toHaveBeenCalledExactlyOnceWith({
      id: 'int-1',
      outcome: 'accepted',
      data: { q0: ['Formal'] },
    })
    expect(onResolved).toHaveBeenCalledWith('int-1', 'answered')
    expect(container.textContent).toContain('Answered')
  })

  it('submits a text answer as { q0: string }', async () => {
    const { container, submitAnswer } = mount(TEXT_INTERACTION)
    fireEvent.change(container.querySelector('textarea')!, { target: { value: 'seed-stage founders' } })
    fireEvent.click(submitButton())
    await flush()
    expect(submitAnswer).toHaveBeenCalledExactlyOnceWith({
      id: 'int-2',
      outcome: 'accepted',
      data: { q0: 'seed-stage founders' },
    })
  })

  it('submits a custom write-in for a single select as the sole answer', async () => {
    const { container, submitAnswer } = mount({
      ...SELECT_INTERACTION,
      fields: [{ ...SELECT_INTERACTION.fields[0], allowCustom: true } as ChatInteraction['fields'][number]],
    })
    fireEvent.change(container.querySelector('input[type="text"]')!, { target: { value: 'chartreuse' } })
    fireEvent.click(submitButton())
    await flush()
    expect(submitAnswer).toHaveBeenCalledExactlyOnceWith({
      id: 'int-1',
      outcome: 'accepted',
      data: { q0: ['chartreuse'] },
    })
  })

  it('keeps the card answerable after a 400 INVALID_INTERACTION_ANSWER', async () => {
    const onResolved = vi.fn()
    const submitAnswer = vi.fn(async (): Promise<InteractionSubmitResult> => ({
      ok: false,
      expired: false,
      message: 'This question needs an answer from the card above — pick one of the listed options.',
    }))
    const { container } = mount(SELECT_INTERACTION, { onResolved, submitAnswer })
    fireEvent.click(screen.getByLabelText('Formal'))
    fireEvent.click(submitButton())
    await flush()

    expect(container.textContent).toContain('pick one of the listed options')
    expect(onResolved).not.toHaveBeenCalled()
    expect(submitButton().disabled).toBe(false)
  })

  it('clears Submitting and shows a retryable error when submit times out', async () => {
    vi.useFakeTimers()
    // A fetch that never resolves but honors its abort signal — the real
    // runtime behavior the 30s submit timeout guards against.
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })) as unknown as typeof fetch
    const submitAnswer = createInteractionAnswerSubmitter({ url: '/api/chat/interactions', fetchImpl })
    const onResolved = vi.fn()
    const { container } = mount(SELECT_INTERACTION, { onResolved, submitAnswer })
    fireEvent.click(screen.getByLabelText('Formal'))
    fireEvent.click(submitButton())
    await flush()

    expect(submitButton().textContent).toContain('Submitting…')

    await act(async () => {
      vi.advanceTimersByTime(30_000)
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Could not reach the agent. Try again.')
    expect(submitButton().disabled).toBe(false)
    expect(onResolved).not.toHaveBeenCalled()
  })

  it('sends an expired select option only after explicit late-submit, never to the dead ask', async () => {
    const messages: string[] = []
    const onLateAnswer = vi.fn((message: string) => {
      messages.push(message)
      return true
    })
    const { container, submitAnswer } = mount({ ...SELECT_INTERACTION, status: 'expired' }, { onLateAnswer })
    fireEvent.click(screen.getByLabelText('Formal'))

    expect(submitAnswer).not.toHaveBeenCalled()
    expect(messages).toEqual([])
    expect(lateAnswerButton().disabled).toBe(false)

    fireEvent.click(lateAnswerButton())
    await flush()

    expect(submitAnswer).not.toHaveBeenCalled()
    expect(messages).toEqual([[
      'Regarding your earlier question: "Which tone do you prefer?"',
      'My answer: Formal',
    ].join('\n')])
    expect(container.textContent).toContain('Sent as new message')
  })

  it('keeps a late answer retryable when the chat surface rejects the send', async () => {
    const { container } = mount({ ...TEXT_INTERACTION, status: 'cancelled' }, { onLateAnswer: () => false })
    fireEvent.change(container.querySelector('textarea')!, { target: { value: 'seed-stage founders' } })
    fireEvent.click(lateAnswerButton())
    await flush()

    expect(container.textContent).toContain('The new message was not sent. Try again from this card.')
    expect(container.textContent).not.toContain('Sent as new message')
    expect(lateAnswerButton().disabled).toBe(false)
  })

  it('blocks late-send for secret-bearing terminal questions', async () => {
    const onLateAnswer = vi.fn(() => true)
    const { container } = mount(SECRET_INTERACTION, { onLateAnswer })
    const input = container.querySelector('input[type="password"]') as HTMLInputElement

    expect(input.disabled).toBe(true)
    expect(container.textContent).toContain('This question asked for a secret, so it cannot be sent as a new chat message.')
    expect(lateAnswerButton().disabled).toBe(true)

    fireEvent.click(lateAnswerButton())
    await flush()

    expect(onLateAnswer).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Sent as new message')
  })

  it('hides the late-answer affordance entirely when onLateAnswer is not wired', () => {
    const { container } = mount({ ...SELECT_INTERACTION, status: 'expired' })
    expect(screen.queryByRole('button', { name: /Send as new message/ })).toBeNull()
    expect(container.textContent).toContain('Expired')
  })

  it('flips to expired on a 410 without a raw error', async () => {
    const submitAnswer = vi.fn(async (): Promise<InteractionSubmitResult> => ({
      ok: false,
      expired: true,
      message: 'This question is no longer waiting for an answer.',
    }))
    const onResolved = vi.fn()
    const { container } = mount(SELECT_INTERACTION, { onResolved, submitAnswer, onLateAnswer: () => true })
    fireEvent.click(screen.getByLabelText('Formal'))
    fireEvent.click(submitButton())
    await flush()

    expect(onResolved).toHaveBeenCalledWith('int-1', 'expired')
    expect(container.textContent).toContain('Expired')
    expect(container.textContent).toContain('send a new message with this context')
    expect(lateAnswerButton().disabled).toBe(false)
  })

  it('renders terminal statuses from the stream (cancel path) with the late-answer action', () => {
    const { container } = mount({ ...SELECT_INTERACTION, status: 'cancelled' }, { onLateAnswer: () => true })
    expect(container.textContent).toContain('Withdrawn')
    expect(container.textContent).toContain('The agent withdrew this question. Answer now to send a new message with this context.')
    // No option picked yet, so the late send has no answer data to carry.
    expect(lateAnswerButton().disabled).toBe(true)
  })

  it('disables inputs for viewers', () => {
    const { container } = mount(SELECT_INTERACTION, { canWrite: false })
    const radios = Array.from(container.querySelectorAll('input[type="radio"]')) as HTMLInputElement[]
    expect(radios.length).toBeGreaterThan(0)
    expect(radios.every((radio) => radio.disabled)).toBe(true)
    expect(submitButton().disabled).toBe(true)
  })
})
