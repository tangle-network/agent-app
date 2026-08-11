// @vitest-environment jsdom
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { InteractionQuestionCard } from './interaction-question-card'
import {
  createInteractionAnswerSubmitter,
  type InteractionSubmitResult,
  type SubmitInteractionAnswer,
} from './interaction-card-support'
import type { ChatFreeTextField, ChatInteraction } from './chat-interactions'

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
    kindLabel?: string
    timeoutNote?: React.ReactNode
    renderMarkdown?: (markdown: string) => React.ReactNode
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
      kindLabel={props.kindLabel}
      timeoutNote={props.timeoutNote}
      renderMarkdown={props.renderMarkdown}
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

/** The card's only textarea, asserted present rather than assumed. */
function textareaOf({ container }: { container: HTMLElement }): HTMLTextAreaElement {
  const textarea = container.querySelector('textarea')
  expect(textarea).not.toBeNull()
  return textarea as HTMLTextAreaElement
}

/** A text ask carrying a length cap, built as a typed `ChatFreeTextField` rather
 *  than cast — so a change to the field shape fails this file at compile time
 *  instead of passing here and breaking the card. */
function cappedTextarea(maxLength: number): HTMLTextAreaElement {
  const field: ChatFreeTextField = {
    type: 'text',
    name: 'q0',
    label: 'Describe your audience',
    required: true,
    maxLength,
  }
  return textareaOf(mount({ ...TEXT_INTERACTION, fields: [field] }))
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
    expect(onResolved).toHaveBeenCalledWith('int-1', 'answered', { q0: ['Formal'] })
    expect(container.textContent).toContain('Answered')
  })

  it('hydrates acknowledged answers from persisted interaction state', () => {
    const { container } = mount({
      ...SELECT_INTERACTION,
      status: 'answered',
      answers: { q0: ['Formal'] },
    })
    expect((screen.getByLabelText('Formal') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Casual') as HTMLInputElement).checked).toBe(false)
    expect(container.textContent).toContain('Answered')
  })

  it('resyncs fields when authoritative persisted answers arrive after mount', () => {
    const submitAnswer = okSubmitter()
    const { rerender } = render(
      <InteractionQuestionCard interaction={SELECT_INTERACTION} canWrite submitAnswer={submitAnswer} />,
    )
    fireEvent.click(screen.getByLabelText('Casual'))
    rerender(
      <InteractionQuestionCard
        interaction={{ ...SELECT_INTERACTION, status: 'answered', answers: { q0: ['Formal'] } }}
        canWrite
        submitAnswer={submitAnswer}
      />,
    )
    expect((screen.getByLabelText('Formal') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Casual') as HTMLInputElement).checked).toBe(false)
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

describe('InteractionQuestionCard host overrides', () => {
  it('badges the ask as a question by default, with no static right-note', () => {
    const { container } = mount(SELECT_INTERACTION)
    expect(container.textContent).toContain('Question')
    // The status badge says what the static "The agent asked for input" note
    // used to repeat — the note is gone in every state.
    expect(container.textContent).not.toContain('The agent asked for input')
  })

  it('lets a non-agent host rename the kind badge', () => {
    const { container } = mount(SELECT_INTERACTION, { kindLabel: 'Decision' })
    expect(container.textContent).toContain('Decision')
  })

  it('renders the body through the host renderer, and as plain text without one', () => {
    const withBody = { ...SELECT_INTERACTION, body: '**ship it**' }
    const plain = mount(withBody)
    expect(plain.container.querySelector('strong')).toBeNull()
    expect(plain.container.textContent).toContain('**ship it**')
    plain.unmount()

    const rendered = mount(withBody, {
      renderMarkdown: (markdown) => <strong>{markdown.replaceAll('*', '')}</strong>,
    })
    expect(rendered.container.querySelector('strong')?.textContent).toBe('ship it')
  })

  it('renders the body through the host renderer and leaves labels as text', () => {
    // `body` only. A field label doubles as the input's accessible name, so it
    // has to stay a string — rendering it as nodes would break `aria-label` or
    // silently disagree with what a screen reader announces.
    const { container } = mount(
      { ...TEXT_INTERACTION, title: '**Title**', body: '**Body**' },
      { renderMarkdown: (markdown) => <em>{markdown.replaceAll('*', '')}</em> },
    )
    const rendered = Array.from(container.querySelectorAll('em')).map((el) => el.textContent)
    expect(rendered).toEqual(['Body'])
    expect(container.textContent).toContain('**Title**')
    expect(container.querySelector('textarea')!.getAttribute('aria-label'))
      .toBe(TEXT_INTERACTION.fields[0]?.label)
  })

  it('shows the timeout note only while the ask is still open', () => {
    const pending = mount(SELECT_INTERACTION, { timeoutNote: 'Answer within 5m, or “Formal” is chosen.' })
    expect(pending.container.textContent).toContain('Answer within 5m, or “Formal” is chosen.')
    pending.unmount()

    // Once answered the consequence of silence is no longer true, and a card
    // still counting down reads as though the answer never landed.
    const answered = mount(
      { ...SELECT_INTERACTION, status: 'answered', answers: { q0: ['Formal'] } },
      { timeoutNote: 'Answer within 5m, or “Formal” is chosen.' },
    )
    expect(answered.container.textContent).not.toContain('Answer within 5m')
  })

  it('shows the timeout note to read-only viewers, who still need to know it will settle itself', () => {
    const { container } = mount(SELECT_INTERACTION, {
      canWrite: false,
      timeoutNote: 'The run fails if nobody answers.',
    })
    expect(container.textContent).toContain('The run fails if nobody answers.')
  })

  it('caps a free-text answer at the length the answer route accepts', () => {
    expect(cappedTextarea(4096).maxLength).toBe(4096)
    cleanup()
    // Uncapped stays uncapped: jsdom reports an absent maxLength as -1.
    expect(textareaOf(mount(TEXT_INTERACTION)).maxLength).toBe(-1)
  })

  it('ignores a cap that would make the field unanswerable', () => {
    expect(cappedTextarea(0).maxLength).toBe(-1)
    cleanup()
    expect(cappedTextarea(12.5).maxLength).toBe(-1)
  })

  it('announces a rejected submit rather than only showing it', async () => {
    const submitAnswer = vi.fn(async (): Promise<InteractionSubmitResult> => ({
      ok: false,
      expired: false,
      message: 'This decision was already answered.',
    }))
    mount(SELECT_INTERACTION, { submitAnswer })
    fireEvent.click(screen.getByLabelText('Formal'))
    fireEvent.click(submitButton())
    await flush()

    expect(screen.getByRole('alert').textContent).toContain('already answered')
    // Still retryable — a rejected submit is not a terminal state.
    expect(submitButton().disabled).toBe(false)
  })

  it('does not wedge on a host submitter that never settles', async () => {
    vi.useFakeTimers()
    // NOT `createInteractionAnswerSubmitter` — that one aborts its own fetch.
    // A product may pass any implementation, commonly one wrapping an untimed
    // `fetch`. Without a deadline on the card, this leaves the in-flight guard
    // set for the life of the instance: "Submitting…" forever, no answer ever
    // sendable again.
    const submitAnswer = vi.fn(() => new Promise<InteractionSubmitResult>(() => {}))
    const { container } = mount(SELECT_INTERACTION, { submitAnswer })
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

    // And the guard really did clear — a retry reaches the submitter again.
    vi.useRealTimers()
    fireEvent.click(submitButton())
    await flush()
    expect(submitAnswer).toHaveBeenCalledTimes(2)
  })

  it('surfaces a throwing host submitter instead of dropping it', async () => {
    // Without normalising, the rejection escapes the click handler as an
    // unhandled rejection and the user is left with a card that silently did
    // nothing.
    const submitAnswer = vi.fn(async () => {
      throw new Error('network is down')
    }) as unknown as SubmitInteractionAnswer
    const { container } = mount(SELECT_INTERACTION, { submitAnswer })
    fireEvent.click(screen.getByLabelText('Formal'))
    fireEvent.click(submitButton())
    await flush()

    expect(container.textContent).toContain('network is down')
    expect(submitButton().disabled).toBe(false)
  })

  it('starts over when the same card is handed the next ask', () => {
    const submitAnswer = okSubmitter()
    const { rerender } = render(
      <InteractionQuestionCard interaction={SELECT_INTERACTION} canWrite submitAnswer={submitAnswer} />,
    )
    fireEvent.click(screen.getByLabelText('Formal'))
    expect((screen.getByLabelText('Formal') as HTMLInputElement).checked).toBe(true)

    // A different question arriving on the same instance must not inherit the
    // previous answer — that is one click from resolving a question the reader
    // never saw.
    rerender(
      <InteractionQuestionCard
        interaction={{ ...SELECT_INTERACTION, id: 'int-next', title: 'Which region?' }}
        canWrite
        submitAnswer={submitAnswer}
      />,
    )
    expect((screen.getByLabelText('Formal') as HTMLInputElement).checked).toBe(false)
    expect(submitButton().disabled).toBe(true)
  })

  it('survives StrictMode double-invocation without re-clearing a fresh answer', () => {
    // The reset runs during render, so StrictMode renders it twice. The guard
    // that stops the second pass re-clearing must be state, not a ref: a ref
    // survives a render React abandons while the resets in the same pass do
    // not, which would leave the guard claiming a reset that never committed.
    const submitAnswer = okSubmitter()
    const { rerender } = render(
      <StrictMode>
        <InteractionQuestionCard interaction={SELECT_INTERACTION} canWrite submitAnswer={submitAnswer} />
      </StrictMode>,
    )
    rerender(
      <StrictMode>
        <InteractionQuestionCard
          interaction={{ ...SELECT_INTERACTION, id: 'int-next' }}
          canWrite
          submitAnswer={submitAnswer}
        />
      </StrictMode>,
    )
    // Answering the NEW ask must stick — a guard that mis-tracked identity
    // would clear this selection on the very next render.
    fireEvent.click(screen.getByLabelText('Formal'))
    expect((screen.getByLabelText('Formal') as HTMLInputElement).checked).toBe(true)
    expect(submitButton().disabled).toBe(false)
  })

  it('clears the previous ask’s resolved chrome when the next ask arrives', async () => {
    const submitAnswer = okSubmitter()
    const { container, rerender } = render(
      <InteractionQuestionCard interaction={SELECT_INTERACTION} canWrite submitAnswer={submitAnswer} />,
    )
    fireEvent.click(screen.getByLabelText('Formal'))
    fireEvent.click(submitButton())
    await flush()
    expect(container.textContent).toContain('Answered')

    rerender(
      <InteractionQuestionCard
        interaction={{ ...SELECT_INTERACTION, id: 'int-next' }}
        canWrite
        submitAnswer={submitAnswer}
      />,
    )
    expect(container.textContent).toContain('Waiting for your answer')
    expect(container.textContent).not.toContain('Answered')
  })
})
