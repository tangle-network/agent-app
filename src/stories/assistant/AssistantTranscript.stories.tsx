import type { Meta, StoryObj } from '@storybook/react'
import type { ReactNode } from 'react'
import { AssistantTranscript, ProposalCard } from '../../assistant'
import type {
  AssistantTranscriptView,
  PendingProposal,
} from '../../assistant/types'
import {
  longHistoryMessages,
  populatedMessages,
  settledUsage,
  streamingMessages,
  streamingReasoning,
  workflowProposal,
} from './fixtures'

/**
 * The panel's built-in conversation renderer (web-react `ChatMessages` under
 * the hood), fed the exact `AssistantTranscriptView` slice the panel hands it.
 * Purely presentational — no client context needed.
 */
const meta: Meta<typeof AssistantTranscript> = {
  title: 'Assistant/Transcript',
  component: AssistantTranscript,
  parameters: { layout: 'centered' },
}

export default meta
type Story = StoryObj<typeof AssistantTranscript>

function viewOf(over: Partial<AssistantTranscriptView>): AssistantTranscriptView {
  return {
    messages: [],
    reasoning: null,
    streamingId: null,
    model: null,
    isStreaming: false,
    isThinking: false,
    pendingProposals: [],
    usage: null,
    renderProposal: () => null,
    ...over,
  }
}

const EMPTY_STATE = (
  <p className="px-4 py-8 text-center text-muted-foreground text-sm">
    Ask me to create a workflow, check your usage, or manage your API keys.
  </p>
)

/** A stand-in for the host's workflow-graph renderer (the real one is the
 *  `@xyflow/react` graph from `./workflows`): three nodes in a flow column, so
 *  the proposal card's Graph/YAML toggle has something to switch between. */
const renderGraph = (_yaml: string) => (
  <div className="flex h-full flex-col items-center justify-center gap-2 bg-secondary p-3">
    <div className="rounded-md border border-border bg-card px-3 py-1.5 text-foreground text-xs">
      Schedule — Mondays 09:00
    </div>
    <div className="h-3 w-px bg-border" />
    <div className="rounded-md border border-border bg-card px-3 py-1.5 text-foreground text-xs">
      canvas/export — page-1 → png
    </div>
    <div className="h-3 w-px bg-border" />
    <div className="rounded-md border border-primary/40 bg-card px-3 py-1.5 text-foreground text-xs">
      slack/send-message — #launch
    </div>
  </div>
)

/** The panel's bound proposal slot, recreated: a real ProposalCard with
 *  console.log handlers and the fake graph. */
function renderProposal(proposal: PendingProposal): ReactNode {
  return (
    <ProposalCard
      proposal={proposal}
      confirming={false}
      onConfirm={() => console.log('[story] confirm', proposal.callId)}
      onCancel={() => console.log('[story] cancel', proposal.callId)}
      navigate={(path) => console.log('[story] navigate', path)}
      renderGraph={renderGraph}
    />
  )
}

function Frame({ children }: { children: ReactNode }) {
  return <div className="w-[400px]">{children}</div>
}

/** Zero-state for a fresh thread. */
export const TranscriptEmpty: Story = {
  name: 'Empty',
  render: () => (
    <Frame>
      <AssistantTranscript view={viewOf({})} emptyState={EMPTY_STATE} />
    </Frame>
  ),
}

/** A settled conversation: text bubbles, an expandable tool chip (args +
 *  result), and the settled turn's cost line under the last answer. */
export const TranscriptPopulated: Story = {
  name: 'Populated',
  render: () => (
    <Frame>
      <AssistantTranscript
        view={viewOf({ messages: populatedMessages, usage: settledUsage })}
        emptyState={EMPTY_STATE}
      />
    </Frame>
  ),
}

/** Mid-turn: reasoning preview on the working bubble, a running tool chip, and
 *  the loading affordance while the open bubble waits for its first delta. */
export const TranscriptStreaming: Story = {
  name: 'Streaming',
  render: () => (
    <Frame>
      <AssistantTranscript
        view={viewOf({
          messages: streamingMessages,
          reasoning: streamingReasoning,
          streamingId: 'a-stream',
          model: 'anthropic/claude-sonnet-4-6',
          isStreaming: true,
          isThinking: true,
        })}
        emptyState={EMPTY_STATE}
      />
    </Frame>
  ),
}

/** A pending proposal rendered inline after its proposing turn, via the same
 *  bound `renderProposal` slot the panel supplies. */
export const TranscriptWithProposal: Story = {
  name: 'With Proposal',
  render: () => (
    <Frame>
      <AssistantTranscript
        view={viewOf({
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
          usage: settledUsage,
          renderProposal,
        })}
        emptyState={EMPTY_STATE}
      />
    </Frame>
  ),
}

/** Twenty messages of back-and-forth in the panel's scroll container — the
 *  story for judging transcript rhythm (bubble spacing, dividers, timestamps)
 *  when the conversation actually scrolls. */
export const TranscriptLongHistory: Story = {
  name: 'Long History',
  render: () => (
    <div className="h-[560px] w-[400px] overflow-y-auto rounded-lg border border-border px-2 py-3">
      <AssistantTranscript
        view={viewOf({ messages: longHistoryMessages, usage: settledUsage })}
        emptyState={EMPTY_STATE}
      />
    </div>
  ),
}

/** The transcript's four working states side by side. */
export const TranscriptStates: Story = {
  name: 'All States',
  parameters: { layout: 'padded' },
  render: () => (
    <div className="grid grid-cols-4 gap-4">
      {(
        [
          ['Empty', viewOf({})],
          ['Populated', viewOf({ messages: populatedMessages, usage: settledUsage })],
          [
            'Streaming',
            viewOf({
              messages: streamingMessages,
              reasoning: streamingReasoning,
              streamingId: 'a-stream',
              isStreaming: true,
              isThinking: true,
            }),
          ],
          [
            'Proposal',
            viewOf({
              messages: [
                { id: 'u1', role: 'user', text: 'Draft the Monday poster workflow.' },
                {
                  id: 'a1',
                  role: 'assistant',
                  text: 'Drafted — confirm below.',
                },
              ],
              pendingProposals: [workflowProposal],
              renderProposal,
            }),
          ],
        ] satisfies ReadonlyArray<readonly [string, AssistantTranscriptView]>
      ).map(([label, view]) => (
        <div key={label} className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">{label}</span>
          <div className="h-[480px] w-[320px] overflow-y-auto rounded-lg border border-border px-2 py-3">
            <AssistantTranscript view={view} emptyState={EMPTY_STATE} />
          </div>
        </div>
      ))}
    </div>
  ),
}
