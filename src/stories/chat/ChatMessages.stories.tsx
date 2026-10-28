import type { Meta, StoryObj } from '@storybook/react'
import { useEffect, useState } from 'react'
import { ChatMessages } from '../../web-react'
import type { ChatMessagesProps, ChatToolCallInfo } from '../../web-react'
import {
  chatCatalogModels,
  chatThread,
  densityThread,
  erroredToolCallMessage,
  multiPartyAuthors,
  multiPartyThread,
  proposalAwaitingApprovalMessage,
  reasoningToolThread,
  shortThread,
  streamingAssistantMessage,
  twoAgentsThread, twoAgentsAnswering,
  usageReportMessage,
} from './fixtures'
import { renderMarkdown } from './markdown'
import { WithRunDrillIn } from './run-drill-in'

/** Approve/Reject wired to the console — the proposal card's live affordance. */
const approval = {
  onApprove: (proposalId: string, toolCallId: string) => console.log('approve', proposalId, toolCallId),
  onReject: (proposalId: string, toolCallId: string) => console.log('reject', proposalId, toolCallId),
}

const meta: Meta<typeof ChatMessages> = {
  title: 'Chat/ChatMessages',
  component: ChatMessages,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-background py-2 text-foreground">
        <Story />
      </div>
    ),
  ],
  args: {
    messages: [],
    models: chatCatalogModels,
    renderMarkdown,
  },
}

export default meta
type Story = StoryObj<typeof ChatMessages>

/** First run: the branded zero-state with three concrete starting doors. */
export const Empty: Story = {
  args: {
    messages: [],
    emptyState: {
      productName: 'Tangle Agent',
      doors: [
        {
          label: 'Start from a template',
          description: 'Launch poster, metrics report, announcement post.',
          onSelect: () => console.log('door: template'),
        },
        {
          label: 'Describe the outcome',
          description: 'The agent works through it step by step.',
          onSelect: () => console.log('door: ask'),
        },
        {
          label: 'Do it by hand',
          description: 'Open the canvas and drive it yourself.',
          onSelect: () => console.log('door: manual'),
        },
      ],
    },
  },
}

/** Loading with a user message last: the trailing "Thinking" row. */
export const AgentThinking: Story = {
  name: 'Agent Thinking',
  args: {
    messages: [{ id: 'u1', role: 'user', content: 'Render the launch poster and queue it for review.' }],
    loading: true,
  },
}

/** Loading with the server's current stage: the row shows it in place of "Thinking…". */
export const AgentPreparingWorkspace: Story = {
  name: 'Agent Preparing Workspace',
  args: {
    messages: [{ id: 'u1', role: 'user', content: 'Render the launch poster and queue it for review.' }],
    loading: true,
    turnPhase: { message: 'Preparing your workspace…' },
  },
}

/** Three turns: user bubble, assistant with reasoning + approval card, follow-up. */
export const Short: Story = {
  args: { messages: shortThread, approval },
}

/**
 * A turn addressed to two agents. The store holds one assistant row; the
 * transcript splits it at its speaker parts and draws each answer under a
 * `SpeakerHeader`, in the order the mentions were typed.
 */
export const TwoAgentsAnswer: Story = {
  name: 'Two agents answer one message',
  args: { messages: twoAgentsThread, renderMarkdown, approval },
}

/** Replays the second responder's text after both headers were admitted. */
function TwoAgentsStream(args: ChatMessagesProps) {
  const [length, setLength] = useState(0)
  const answer = 'Checking the roster and the mention routes before naming risks.\n\nThe first risk is an empty roster in a new workspace. The second is a renamed handle that stays reserved. The third is a routine posting while nobody is watching. Each needs an explicit state and a useful next action. '
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>
    const delay = setTimeout(() => {
      let shown = 0
      interval = setInterval(() => {
        shown = Math.min(shown + 12, answer.length); setLength(shown)
        if (shown === answer.length) clearInterval(interval)
      }, 160)
    }, 1500)
    return () => { clearTimeout(delay); clearInterval(interval) }
  }, [])
  const messages = twoAgentsAnswering.map((message) => message.role !== 'assistant' ? message : {
    ...message,
    parts: message.parts!.map((part, index) => index === 5 ? { ...part, text: answer.slice(0, length) } : part),
  })
  return <div data-stream-length={length} data-stream-complete={length === answer.length}><ChatMessages {...args} messages={messages} /></div>
}

export const TwoAgentsAnswering: Story = {
  name: 'Two agents answering at once',
  args: { renderMarkdown, approval, loading: true },
  render: (args) => <TwoAgentsStream {...args} />,
}

/**
 * The full 16-message thread: reasoning disclosures, per-message model/cost
 * metrics, interleaved segments, a pending proposal, an errored tool call, and
 * a trailing in-flight turn. The spacing/density reference — evaluate this one
 * against Conductor/Codex/Claude Desktop.
 */
export const LongHistory: Story = {
  name: 'Long History',
  args: {
    messages: chatThread,
    approval,
  },
  render: (args) => (
    <WithRunDrillIn>
      {(onToolCallClick) => <ChatMessages {...args} onToolCallClick={onToolCallClick} />}
    </WithRunDrillIn>
  ),
}

/** A turn in flight: the last assistant message types out with the caret, its
 *  tool call still running, and no completion metrics yet. */
export const StreamingInProgress: Story = {
  name: 'Streaming In Progress',
  args: {
    messages: [
      { id: 's1', role: 'user', content: 'Export a print-resolution PNG for the record.' },
      streamingAssistantMessage,
    ],
    loading: true,
  },
}

/** The pending-decision surface: Approve is filled/primary, Reject is quiet. */
export const ProposalAwaitingApproval: Story = {
  name: 'Proposal Awaiting Approval',
  args: {
    messages: [
      { id: 'p1', role: 'user', content: 'Render the poster and queue it for review.' },
      proposalAwaitingApprovalMessage,
    ],
    approval,
  },
}

/** A failed tool call in the transcript, plus the stream-error row with Retry. */
export const ErroredToolCall: Story = {
  name: 'Errored Tool Call + Retry',
  args: {
    messages: [
      { id: 'e1', role: 'user', content: 'Schedule the follow-up for Monday at 09:00.' },
      erroredToolCallMessage,
    ],
    error: 'The model stream dropped before the turn finished (transport closed).',
    onRetry: () => console.log('retry turn'),
  },
}

/** Reasoning-heavy, tool-heavy: a settled 4-tool run collapses into one
 *  disclosure; a later turn interleaves text and tool rows chronologically. */
export const ReasoningToolHeavy: Story = {
  name: 'Reasoning + Tool Heavy',
  args: { messages: reasoningToolThread },
}

/**
 * Consumer-extension DX: the host injects a per-tool detail body via
 * `toolRenderers` (here a styled cost panel for `usage_report`). Expand the
 * "Usage report" row to see it replace the generic key/value detail.
 */
export const CustomToolRenderer: Story = {
  name: 'Custom Tool Renderer',
  args: {
    messages: usageReportMessage,
    toolRenderers: {
      usage_report: (call: ChatToolCallInfo) => {
        const outcome = call.result as
          | { ok?: boolean; result?: { promptTokens?: number; completionTokens?: number; estimatedCostUsd?: number } }
          | undefined
        const r = outcome?.result ?? {}
        return (
          <div className="flex items-center gap-4 rounded-md border border-card-edge bg-card px-3 py-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Prompt</p>
              <p className="font-mono text-sm text-foreground">{(r.promptTokens ?? 0).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Completion</p>
              <p className="font-mono text-sm text-foreground">{(r.completionTokens ?? 0).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Est. cost</p>
              <p className="font-mono text-sm text-foreground">${(r.estimatedCostUsd ?? 0).toFixed(4)}</p>
            </div>
          </div>
        )
      },
    },
  },
  render: (args: ChatMessagesProps) => (
    <>
      <p className="mx-auto w-full max-w-3xl px-6 pb-1 pt-3 text-xs text-muted-foreground">
        Expand the “Usage report” row — its detail body comes from this story’s `toolRenderers` entry.
      </p>
      <ChatMessages {...args} />
    </>
  ),
}

/** Products can give repeated tool names useful, call-specific identities
 *  without replacing the shared row geometry or keyboard expansion. */
export const DistinctToolPresentation: Story = {
  name: 'Distinct Tool Presentation',
  args: {
    messages: [{
      id: 'distinct-tools',
      role: 'assistant',
      content: 'Both source records are shown below.',
      toolCalls: [
        { id: 'mood-call', name: 'read_record', status: 'done', args: { recordId: 'mood-042' } },
        { id: 'sleep-call', name: 'read_record', status: 'done', args: { recordId: 'sleep-018' } },
      ],
    }],
    toolRenderers: {
      read_record: (call: ChatToolCallInfo) => {
        const mood = call.args?.recordId === 'mood-042'
        return {
          title: mood ? 'Read mood check-in' : 'Read overnight sleep',
          description: mood ? 'Mood score · 4/5' : 'Sleep duration · 7 h 24 min',
          detail: (
            <dl className="grid max-w-full grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Record</dt><dd className="break-all">{String(call.args?.recordId)}</dd>
              <dt className="text-muted-foreground">Source</dt><dd>{mood ? 'Manual check-in' : 'Synthetic sleep tracker'}</dd>
              <dt className="text-muted-foreground">Measured</dt><dd>{mood ? '2026-10-24 08:15 -04:00' : '2026-10-24 06:42 -04:00'}</dd>
            </dl>
          ),
        }
      },
    },
  },
}

/**
 * The same six-turn thread at 480 / 720 / 960px containers, side by side. The
 * column caps at `max-w-3xl` (768px), so 960px shows the centered ceiling while
 * 480/720px show the fluid range — the spacing/density comparison surface.
 */
export const DensityComparison: Story = {
  name: 'Density Comparison (480 / 720 / 960px)',
  render: () => (
    <div className="flex items-start gap-6">
      {[480, 720, 960].map((width) => (
        <section key={width} className="shrink-0 rounded-lg border border-border bg-background" style={{ width }}>
          <p className="border-b border-border px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {width}px container
          </p>
          <ChatMessages
            messages={densityThread}
            models={chatCatalogModels}
            renderMarkdown={renderMarkdown}
            approval={approval}
          />
        </section>
      ))}
    </div>
  ),
}

/** Reading scale side by side: `messageSize` default (16px) vs large (17px) on
 *  the same thread, same width — prose size changes without touching chrome. */
export const MessageSizeComparison: Story = {
  name: 'Message Size Comparison (default / large)',
  render: () => (
    <div className="flex items-start gap-6">
      {(['default', 'large'] as const).map((size) => (
        <section key={size} className="w-[520px] shrink-0 rounded-lg border border-border bg-background">
          <p className="border-b border-border px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            messageSize: {size}
          </p>
          <ChatMessages
            messages={shortThread}
            models={chatCatalogModels}
            renderMarkdown={renderMarkdown}
            approval={approval}
            messageSize={size}
          />
        </section>
      ))}
    </div>
  ),
}

// ── Quiet chrome (opt-in) ────────────────────────────────────────────────────

/** The full 16-message thread from Long History under the opt-in quiet chrome:
 *  no role labels, a hover-revealed meta lane (copy + demoted model/cost), and
 *  inverse user bubbles. Hover a row to see the lane. */
export const QuietLongHistory: Story = {
  name: 'Quiet · Long History',
  args: {
    messages: chatThread,
    approval,
    chrome: 'quiet',
  },
  render: (args) => (
    <WithRunDrillIn>
      {(onToolCallClick) => <ChatMessages {...args} onToolCallClick={onToolCallClick} />}
    </WithRunDrillIn>
  ),
}

/** Quiet chrome with a turn in flight: streaming text, running tool call, and
 *  a meta lane that carries only what exists yet (copy + model, no tok/s/cost
 *  until the turn settles). */
export const QuietStreamingInProgress: Story = {
  name: 'Quiet · Streaming In Progress',
  args: {
    messages: [
      { id: 's1', role: 'user', content: 'Export a print-resolution PNG for the record.' },
      streamingAssistantMessage,
    ],
    loading: true,
    chrome: 'quiet',
  },
}

/** Quiet chrome on the pending-decision surface: the approval card is
 *  identical to labeled mode — only the row chrome around it changes. */
export const QuietProposalAwaitingApproval: Story = {
  name: 'Quiet · Proposal Awaiting Approval',
  args: {
    messages: [
      { id: 'p1', role: 'user', content: 'Render the poster and queue it for review.' },
      proposalAwaitingApprovalMessage,
    ],
    approval,
    chrome: 'quiet',
  },
}

/**
 * The same six-turn thread at equal width in labeled and quiet chrome.
 * Hover rows in the right column to reveal its meta lane.
 */
export const BeforeAfter: Story = {
  name: 'Labeled / Quiet',
  render: () => (
    <div className="flex items-start gap-6">
      {(['labeled', 'quiet'] as const).map((chrome) => (
        <section key={chrome} className="w-[560px] shrink-0 rounded-lg border border-border bg-background">
          <p className="border-b border-border px-3 py-2 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {chrome}
          </p>
          <ChatMessages
            messages={densityThread}
            models={chatCatalogModels}
            renderMarkdown={renderMarkdown}
            approval={approval}
            chrome={chrome}
          />
        </section>
      ))}
    </div>
  ),
}

/** A thread three participants share, on the client's screen: the client's own
 *  messages stay right-aligned; the attorney and the agent are named. */
export const MultiParty: Story = {
  name: 'Multi-party (client view)',
  args: { messages: multiPartyThread, viewerId: multiPartyAuthors.client.id },
}

/** The same thread on the attorney's screen. */
export const MultiPartyAttorneyView: Story = {
  name: 'Multi-party (attorney view)',
  args: { messages: multiPartyThread, viewerId: multiPartyAuthors.attorney.id },
}

/** Quiet chrome keeps every name; the copy lane sits on each sender's side. */
export const QuietMultiParty: Story = {
  name: 'Quiet multi-party',
  args: { messages: multiPartyThread, viewerId: multiPartyAuthors.client.id, chrome: 'quiet' },
}
