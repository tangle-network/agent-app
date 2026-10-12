import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import {
  ChatMessages,
  ReasoningRow,
  chatReasoningFromParts,
  trackChatReasoning,
  type ChatReasoningState,
  type ChatUiMessage,
} from '../../web-react'
import { renderMarkdown } from './markdown'

/**
 * The shared reasoning row. `Live turn` plays a reasoning model's turn through
 * the same client path an app uses: wire deltas go through
 * `trackChatReasoning`, and its `ChatReasoningState` drives `ChatMessages`.
 */
const meta: Meta<typeof ReasoningRow> = {
  title: 'Chat/ReasoningRow',
  component: ReasoningRow,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-background py-6 text-foreground">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof ReasoningRow>

/** A reasoning summary as a gpt-6 model streams it: a bold heading, then prose, in small deltas. */
const REASONING = [
  '**Checking', ' what is', ' ready**\n\n', 'The question is', ' how many rooms', ' can take a guest', ' tonight.',
  ' Ready means', ' cleaned and', ' inspected,', ' so I should', ' count only rooms', ' whose last inspection', ' passed.',
  '\n\n**Answering', ' briefly**\n\n', 'Four rooms', ' passed inspection', ' this afternoon;', ' I will give', ' the number', ' and name them.',
]
const ANSWER = ['Four rooms ', 'are ready tonight: ', '101, 104, 207 ', 'and 210.']

/** One turn's wire events and when each arrives, in ms from the start. */
const TIMELINE: Array<{ at: number; line: Record<string, unknown> }> = [
  ...REASONING.map((text, i) => ({ at: 600 + i * 260, line: { kind: 'event', event: { type: 'reasoning', text } } })),
  ...ANSWER.map((text, i) => ({ at: 600 + REASONING.length * 260 + 700 + i * 180, line: { kind: 'event', event: { type: 'text', text } } })),
]

const QUESTION: ChatUiMessage = { id: 'u1', role: 'user', content: 'How many rooms are ready tonight?' }

function LiveTurnDemo() {
  const [run, setRun] = useState(0)
  const [reasoning, setReasoning] = useState<ChatReasoningState | null>(null)
  const [answer, setAnswer] = useState('')
  const [streaming, setStreaming] = useState(true)

  useEffect(() => {
    setReasoning(null)
    setAnswer('')
    setStreaming(true)
    const callbacks = trackChatReasoning({
      onReasoningState: setReasoning,
      onText: (delta) => setAnswer((text) => text + delta),
    })
    const timers = TIMELINE.map(({ at, line }) => setTimeout(() => {
      const event = line.event as { type: string; text: string }
      if (event.type === 'reasoning') callbacks.onReasoning?.(event.text)
      else callbacks.onText?.(event.text)
    }, at))
    const last = TIMELINE[TIMELINE.length - 1]!.at
    timers.push(setTimeout(() => { callbacks.end(); setStreaming(false) }, last + 200))
    return () => timers.forEach(clearTimeout)
  }, [run])

  const messages = useMemo<ChatUiMessage[]>(() => [
    QUESTION,
    {
      id: `a${run}`,
      role: 'assistant',
      content: answer,
      modelUsed: 'gpt-6-luna',
      ...(reasoning
        ? { reasoning: reasoning.text, reasoningStartedAt: reasoning.startedAt, reasoningEndedAt: reasoning.endedAt }
        : {}),
    },
  ], [answer, reasoning, run])

  return (
    <div>
      <ChatMessages messages={messages} loading={streaming} renderMarkdown={renderMarkdown} agentLabel="Agent" />
      <div className="mx-auto w-full max-w-3xl px-6">
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setRun((n) => n + 1)}
        >
          Replay turn
        </button>
      </div>
    </div>
  )
}

/** A reasoning model's turn, live: the reasoning streams open under "Thinking · Ns", then collapses to "Thought for N seconds" when the answer starts. */
export const LiveTurn: Story = {
  render: () => <LiveTurnDemo />,
}

const framed = (row: ReactNode) => <div className="mx-auto w-full max-w-3xl px-6">{row}</div>

/** Mid-thought: the model started eight seconds ago and is still reasoning. */
export const Thinking: Story = {
  render: function ThinkingStory() {
    const [startedAt] = useState(() => Date.now() - 8_000)
    return framed(<ReasoningRow text={REASONING.slice(0, 9).join('')} startedAt={startedAt} />)
  },
}

/** A reloaded turn: the saved reasoning parts, read back collapsed with how long the model thought. */
export const Saved: Story = {
  render: () => {
    const saved = chatReasoningFromParts([
      { type: 'reasoning', text: REASONING.slice(0, 14).join(''), time: { start: 1_000, end: 4_200 } },
      { type: 'tool', tool: 'rooms.ready', state: { status: 'completed' } },
      { type: 'reasoning', text: REASONING.slice(14).join(''), time: { start: 5_000, end: 8_100 } },
    ])
    return framed(saved ? <ReasoningRow {...saved} /> : null)
  },
}

/** A turn saved before reasoning carried its times: still collapsed and expandable, without a duration. */
export const SavedWithoutTimes: Story = {
  name: 'Saved without times',
  render: () => framed(<ReasoningRow text={REASONING.join('')} />),
}

/** A turn without reasoning: the row renders nothing. */
export const NoReasoning: Story = {
  name: 'No reasoning',
  render: () => framed(<ReasoningRow text="" />),
}
