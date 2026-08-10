import type { Meta, StoryObj } from '@storybook/react'
import { ChatMessages } from '../../web-react'
import type { ChatMessagesProps, ChatToolCallInfo } from '../../web-react'
import {
  chatCatalogModels,
  chatThread,
  densityThread,
  erroredToolCallMessage,
  proposalAwaitingApprovalMessage,
  reasoningToolThread,
  shortThread,
  streamingAssistantMessage,
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

/** Three turns: user bubble, assistant with reasoning + approval card, follow-up. */
export const Short: Story = {
  args: { messages: shortThread, approval },
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
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Prompt</p>
              <p className="font-mono text-sm text-foreground">{(r.promptTokens ?? 0).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Completion</p>
              <p className="font-mono text-sm text-foreground">{(r.completionTokens ?? 0).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Est. cost</p>
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
          <p className="border-b border-border px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
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
          <p className="border-b border-border px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
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
 *  neutral symmetric user bubbles. Hover a row to see the lane. */
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
 * The redesign's comparison surface: the same six-turn thread at equal width,
 * current labeled chrome next to the opt-in quiet chrome. Hover rows in the
 * right column to reveal the meta lane; the left column never changes.
 */
export const BeforeAfter: Story = {
  name: 'Before / After (current: labeled · new: quiet)',
  render: () => (
    <div className="flex items-start gap-6">
      {(['labeled', 'quiet'] as const).map((chrome) => (
        <section key={chrome} className="w-[560px] shrink-0 rounded-lg border border-border bg-background">
          <p className="border-b border-border px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {chrome === 'labeled' ? 'current: labeled' : 'new: quiet'}
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
