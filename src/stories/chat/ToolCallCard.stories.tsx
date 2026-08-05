import type { Meta, StoryObj } from '@storybook/react'
import { ChatMessages } from '../../web-react'
import type { ChatToolCallInfo, ChatUiMessage } from '../../web-react'
import {
  chatCatalogModels,
  doneShellToolCall,
  erroredToolCall,
  proposalToolCall,
  runningToolCall,
  scheduledFollowupToolCall,
} from './fixtures'
import { renderMarkdown } from './markdown'

/**
 * `ToolCallCard` (and its ProposalCard / FollowupCard faces) is an internal
 * component — consumers reach it only through a message's `toolCalls`. These
 * stories therefore mount one-card threads through `ChatMessages`, exactly as
 * a consumer would produce each state.
 */

/** A minimal assistant turn carrying a single tool call. */
function threadWith(call: ChatToolCallInfo): ChatUiMessage[] {
  return [
    {
      id: `card-${call.id}`,
      role: 'assistant',
      content: '',
      modelUsed: 'anthropic/claude-opus-4',
      toolCalls: [call],
    },
  ]
}

const approval = {
  onApprove: (proposalId: string, toolCallId: string) => console.log('approve', proposalId, toolCallId),
  onReject: (proposalId: string, toolCallId: string) => console.log('reject', proposalId, toolCallId),
}

/** Keep the one-card threads at a realistic chat-column width. */
const cardWidth = (Story: React.ComponentType) => (
  <div className="w-[560px]">
    <Story />
  </div>
)

const meta: Meta<typeof ChatMessages> = {
  title: 'Chat/ToolCallCard',
  component: ChatMessages,
  decorators: [
    (Story) => (
      <div className="bg-background p-4 text-foreground">
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

/** Settled sandbox command: green dot, mono title; expand for the terminal
 *  detail (command, stdout, exit code). */
export const Success: Story = {
  args: { messages: threadWith(doneShellToolCall) },
  decorators: [cardWidth],
}

/** Still executing: pulsing amber dot and "running…", no result body yet. */
export const Running: Story = {
  args: { messages: threadWith(runningToolCall) },
  decorators: [cardWidth],
}

/** Failed run: destructive border/background, "failed", error message inside. */
export const Error: Story = {
  args: { messages: threadWith(erroredToolCall) },
  decorators: [cardWidth],
}

/** Settled follow-up: a time-based intent, not an action — quiet left-rule
 *  card with the scheduled time. */
export const ScheduledFollowup: Story = {
  name: 'Scheduled Followup',
  args: { messages: threadWith(scheduledFollowupToolCall) },
  decorators: [cardWidth],
}

/** Pending decision: filled primary Approve, quiet Reject, preview line. */
export const AwaitingApproval: Story = {
  name: 'Awaiting Approval',
  args: { messages: threadWith(proposalToolCall), approval },
  decorators: [cardWidth],
}

/** Same pending proposal without handlers: read-only "Awaiting approval…". */
export const AwaitingApprovalReadOnly: Story = {
  name: 'Awaiting Approval (read-only)',
  args: { messages: threadWith(proposalToolCall) },
  decorators: [cardWidth],
}

/** Every card kind side by side — the at-a-glance check that the four visual
 *  kinds (command / proposal / followup / generic) plus the failure and
 *  running states actually read differently. */
export const Variants: Story = {
  name: 'All Variants',
  parameters: { layout: 'fullscreen' },
  render: () => {
    const panels: Array<{ label: string; call: ChatToolCallInfo; withApproval?: boolean }> = [
      { label: 'Success — sandbox command', call: doneShellToolCall },
      { label: 'Running — in flight', call: runningToolCall },
      { label: 'Error — failed run', call: erroredToolCall },
      { label: 'Scheduled followup', call: scheduledFollowupToolCall },
      { label: 'Awaiting approval — with handlers', call: proposalToolCall, withApproval: true },
      { label: 'Awaiting approval — read-only', call: proposalToolCall },
    ]
    return (
      <div className="flex flex-wrap items-start gap-8">
        {panels.map((panel) => (
          <figure key={panel.label} className="w-[560px]">
            <figcaption className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {panel.label}
            </figcaption>
            <ChatMessages
              messages={threadWith(panel.call)}
              models={chatCatalogModels}
              renderMarkdown={renderMarkdown}
              approval={panel.withApproval ? approval : undefined}
            />
          </figure>
        ))}
      </div>
    )
  },
}
