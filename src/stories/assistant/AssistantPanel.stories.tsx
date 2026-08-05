import type { Meta, StoryObj } from '@storybook/react'
import type { ReactNode } from 'react'
import { AssistantClientProvider, AssistantPanel } from '../../assistant'
import type { AssistantState } from '../../assistant/reducer'
import {
  makeFakeChat,
  populatedMessages,
  settledUsage,
  streamingMessages,
  streamingReasoning,
  STORY_USER_ID,
  stubClient,
  workflowProposal,
} from './fixtures'

/**
 * The chat panel the dock's drawer hosts. Stories drive it with a controlled
 * `AssistantChat` handle (the same fake the panel's tests use), so each story
 * is one exact conversation state — no streaming waits. The model picker and
 * history view read the stub client's fixtures.
 */
const meta: Meta<typeof AssistantPanel> = {
  title: 'Assistant/Panel',
  component: AssistantPanel,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <AssistantClientProvider client={stubClient}>
        <Story />
      </AssistantClientProvider>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof AssistantPanel>

/** The drawer-sized frame the panel is designed for (default dock width 448px,
 *  trimmed to sit comfortably in the canvas). */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="h-[640px] w-[400px] overflow-hidden rounded-lg border border-border shadow-xl">
      {children}
    </div>
  )
}

function Panel({ state }: { state?: Partial<AssistantState> }) {
  return (
    <Frame>
      <AssistantPanel
        chat={makeFakeChat(state)}
        userId={STORY_USER_ID}
        onClose={() => console.log('[story] close')}
        navigate={(path) => console.log('[story] navigate', path)}
        balanceUsd={12.4}
      />
    </Frame>
  )
}

/** Fresh chat: the empty-state copy, the model picker, and the header balance. */
export const PanelEmpty: Story = {
  name: 'Empty',
  render: () => <Panel />,
}

/** A settled conversation: tool chip with an expandable result, the per-turn
 *  cost line, and the first user message truncated into the header title. */
export const PanelOpen: Story = {
  name: 'Open (populated)',
  render: () => (
    <Panel
      state={{
        threadId: 't-poster',
        messages: populatedMessages,
        model: 'anthropic/claude-sonnet-4-6',
        usage: settledUsage,
      }}
    />
  ),
}

/** Mid-turn: the reasoning preview, a running tool chip, the "Working…" cue
 *  above the composer, and the composer's Stop button. */
export const PanelStreaming: Story = {
  name: 'Streaming',
  render: () => (
    <Panel
      state={{
        threadId: 't-poster',
        status: 'streaming',
        streamingId: 'a-stream',
        streamBaseId: 'a-stream',
        messages: streamingMessages,
        reasoning: streamingReasoning,
        model: 'anthropic/claude-sonnet-4-6',
      }}
    />
  ),
}

/** A mutating action awaiting confirmation: the proposal card renders inline
 *  (with its integration requirements), and the composer is gated until the
 *  card is resolved. */
export const PanelWithProposal: Story = {
  name: 'With Proposal',
  render: () => (
    <Panel
      state={{
        threadId: 't-poster',
        status: 'awaiting_confirm',
        messages: [
          {
            id: 'u1',
            role: 'user',
            text: 'Draft a workflow that posts the poster every Monday.',
          },
          {
            id: 'a1',
            role: 'assistant',
            text: 'Here’s the workflow. Slack isn’t connected yet — connect it below, then confirm.',
          },
        ],
        pendingProposals: [workflowProposal],
        model: 'anthropic/claude-sonnet-4-6',
        usage: settledUsage,
      }}
    />
  ),
}

/** A terminal stream error with a remedy: the banner carries the CTA and the
 *  low-balance nudge stays hidden while an error is showing. */
export const PanelError: Story = {
  name: 'Error',
  render: () => (
    <Panel
      state={{
        messages: populatedMessages.slice(0, 2),
        error: { code: 'INSUFFICIENT_BALANCE', message: 'out of credits' },
      }}
    />
  ),
}

/** Balance under the $1 threshold: the quiet nudge above the composer. */
export const PanelLowBalance: Story = {
  name: 'Low Balance',
  render: () => (
    <Frame>
      <AssistantPanel
        chat={makeFakeChat({ threadId: 't-poster', messages: populatedMessages })}
        userId={STORY_USER_ID}
        onClose={() => console.log('[story] close')}
        navigate={(path) => console.log('[story] navigate', path)}
        balanceUsd={0.42}
      />
    </Frame>
  ),
}

/** Every panel state side by side — the visual smoke check for spacing, banner
 *  treatment, and theme tokens across the panel's surface area. */
export const PanelStates: Story = {
  name: 'All States',
  parameters: { layout: 'padded' },
  render: () => (
    <div className="grid grid-cols-3 gap-4">
      {(
        [
          ['Empty', {}],
          [
            'Streaming',
            {
              status: 'streaming',
              streamingId: 'a-stream',
              streamBaseId: 'a-stream',
              messages: streamingMessages,
              reasoning: streamingReasoning,
            },
          ],
          [
            'Proposal',
            {
              status: 'awaiting_confirm',
              messages: [
                { id: 'u1', role: 'user', text: 'Draft the Monday poster workflow.' },
              ],
              pendingProposals: [workflowProposal],
            },
          ],
          [
            'Error',
            { error: { code: 'INSUFFICIENT_BALANCE', message: 'out of credits' } },
          ],
          ['Populated', { messages: populatedMessages, usage: settledUsage }],
          [
            'Capped',
            {
              messages: populatedMessages,
              usage: settledUsage,
              capped: true,
            },
          ],
        ] satisfies ReadonlyArray<readonly [string, Partial<AssistantState>]>
      ).map(([label, state]) => (
        <div key={label} className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">{label}</span>
          <div className="h-[440px] w-[340px] overflow-hidden rounded-lg border border-border">
            <AssistantPanel
              chat={makeFakeChat(state)}
              userId={STORY_USER_ID}
              onClose={() => console.log('[story] close')}
              navigate={(path) => console.log('[story] navigate', path)}
            />
          </div>
        </div>
      ))}
    </div>
  ),
}
