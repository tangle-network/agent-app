/**
 * App Shell — the design-evaluation centerpiece. The package ships no generic
 * app-shell component; these stories compose one at story level from package
 * primitives (`ChatMessages`, `ChatComposer` from `../../web-react`, the brand
 * mark from `../../brand`) over the story-local shell in `./shell`, so the
 * spacing / consolidation / sidebar-config critique happens against something
 * that looks like a real production agent app.
 *
 * One story per domain state (populated / streaming / empty / proposal
 * pending), a sidebar-variant composite, and a mobile-viewport story.
 */
import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { ChevronDown } from 'lucide-react'
import {
  ChatComposer,
  ChatMessages,
  type ChatEmptyStateProps,
  type ChatUiMessage,
  type ProposalApprovalHandlers,
} from '../../web-react'
import { AppShell, AppSidebar, type AppShellProps } from './shell'
import {
  chatThread,
  proposalAwaitingApprovalMessage,
  shellModels,
  shellSections,
  streamingAssistantMessage,
  withSessionStatus,
} from './fixtures'

const meta: Meta<typeof AppShell> = {
  title: 'App Shell/AppShell',
  component: AppShell,
  parameters: { layout: 'fullscreen' },
  args: {
    sections: shellSections,
    activeSessionId: 'launch-poster',
    pendingApprovals: 0,
    user: { name: 'Drew Stone', email: 'drew@tangle.tools' },
    headerTitle: 'Launch poster review',
    headerSubtitle: 'Workspace · launch-poster · sandbox connected',
    onNewChat: () => console.log('new-chat'),
    onSelectSession: (id) => console.log('select-session', id),
    onToggleCollapse: () => console.log('toggle-collapse'),
    onOpenApprovals: () => console.log('open-approvals'),
    onOpenSettings: () => console.log('open-settings'),
    onOpenAccount: () => console.log('open-account'),
    onShare: () => console.log('share-thread'),
    onOpenThreadMenu: () => console.log('thread-menu'),
  },
}

export default meta
type Story = StoryObj<typeof meta>

// ── shared scene ──────────────────────────────────────────────────────────────

const controlChipClass =
  'inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-accent/40 hover:text-foreground'

const composerControls = (
  <>
    <button type="button" onClick={() => console.log('pick-model')} className={controlChipClass}>
      Claude Opus 4
      <ChevronDown className="h-3 w-3" />
    </button>
    <button type="button" onClick={() => console.log('pick-effort')} className={controlChipClass}>
      Effort: High
      <ChevronDown className="h-3 w-3" />
    </button>
  </>
)

interface SceneProps {
  args: AppShellProps
  messages: ChatUiMessage[]
  /** Marks the last assistant turn as in-flight (streaming cursor in the
   *  thread, Stop in the composer). */
  streaming?: boolean
  approval?: ProposalApprovalHandlers
  emptyState?: ChatEmptyStateProps
  /** Opt the transcript + composer into the quiet chrome / floating variants. */
  quiet?: boolean
}

/**
 * The composed scene every shell story renders. Sidebar collapse is real
 * (local state, not console.log) because it is the interaction the sidebar
 * variants exist to evaluate; everything else is a logged callback.
 */
function ShellScene({ args, messages, streaming = false, approval, emptyState, quiet = false }: SceneProps) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <AppShell
      {...args}
      sidebarCollapsed={collapsed}
      onToggleCollapse={() => setCollapsed((v) => !v)}
      composer={
        <ChatComposer
          onSend={(message) => console.log('send', message)}
          onCancel={() => console.log('cancel-stream')}
          isStreaming={streaming}
          placeholder="Message the agent…"
          controls={composerControls}
          floating={quiet}
        />
      }
    >
      <ChatMessages
        messages={messages}
        models={shellModels}
        loading={streaming}
        approval={approval}
        emptyState={emptyState}
        userLabel="You"
        agentLabel="Agent"
        onToolCallClick={(call) => console.log('tool-call', call.id)}
        chrome={quiet ? 'quiet' : 'labeled'}
      />
    </AppShell>
  )
}

// ── domain states ─────────────────────────────────────────────────────────────

/** The everyday state: a long settled thread with reasoning, tool chips,
 *  per-message cost lines, and one background session still running. */
export const Default: Story = {
  name: 'Default — populated thread',
  render: (args) => <ShellScene args={args} messages={chatThread} />,
}

/** A turn in flight: partial assistant text with a live tool call, streaming
 *  cursor on the last message, and the composer's Stop button. */
export const Streaming: Story = {
  args: {
    sections: withSessionStatus(shellSections, 'launch-poster', 'running'),
  },
  render: (args) => (
    <ShellScene args={args} messages={[...chatThread.slice(0, 11), streamingAssistantMessage]} streaming />
  ),
}

/** First run in a fresh workspace: `ChatMessages` with no messages falls back
 *  to the branded `ChatEmptyState` with three concrete doors. */
export const EmptyState: Story = {
  name: 'Empty state',
  args: { activeSessionId: null, headerTitle: 'New chat', headerSubtitle: 'No workspace selected' },
  render: (args) => (
    <ShellScene
      args={args}
      messages={[]}
      emptyState={{
        productName: 'Agent',
        headline: 'What should the agent work on?',
        subline:
          'Describe the outcome you want. The agent works through it step by step, and pauses for your approval before anything irreversible.',
        doors: [
          {
            label: 'Review pending approvals',
            description: 'Two proposals are waiting on a human ruling.',
            onSelect: () => console.log('door: approvals'),
          },
          {
            label: 'Start from a template',
            description: 'Launch a campaign workspace with the standard checklist.',
            onSelect: () => console.log('door: template'),
          },
          {
            label: 'Audit last week’s spend',
            description: 'Token usage and cost across every active workspace.',
            onSelect: () => console.log('door: spend-audit'),
          },
        ],
      }}
    />
  ),
}

/** The quiet transcript end to end: label-free rows with hover-revealed meta
 *  lanes + the floating composer, inside the full shell. This is the
 *  Conductor/qm-comparison surface — evaluate it against Default. */
export const QuietTranscript: Story = {
  name: 'Quiet transcript',
  render: (args) => <ShellScene args={args} messages={chatThread} quiet />,
}

/** The approval gate, end to end: the queued proposal card gets Approve /
 *  Reject buttons, the header shows the pending count, and the active sidebar
 *  session carries the amber awaiting-approval dot. */
export const ProposalPending: Story = {
  name: 'Proposal pending',
  args: {
    pendingApprovals: 1,
    sections: withSessionStatus(shellSections, 'launch-poster', 'approval'),
  },
  render: (args) => (
    <ShellScene
      args={args}
      messages={[...chatThread.slice(0, 2), proposalAwaitingApprovalMessage]}
      approval={{
        onApprove: (proposalId, toolCallId) => console.log('approve', proposalId, toolCallId),
        onReject: (proposalId, toolCallId) => console.log('reject', proposalId, toolCallId),
      }}
    />
  ),
}

// ── composites ────────────────────────────────────────────────────────────────

/** The sidebar configuration matrix side by side: comfortable vs compact row
 *  rhythm, and the collapsed icon rail. This is the sidebar-config critique
 *  surface — judge row padding, section spacing, and affordance sizing here. */
export const SidebarVariants: Story = {
  name: 'Sidebar variants',
  parameters: { layout: 'padded' },
  render: () => (
    <div className="flex flex-wrap items-start gap-8">
      {[
        { label: 'Expanded · comfortable', props: {} },
        { label: 'Expanded · compact', props: { density: 'compact' as const } },
        { label: 'Collapsed rail', props: { collapsed: true } },
      ].map((variant) => (
        <div key={variant.label} className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{variant.label}</p>
          <div className="h-[720px] overflow-hidden rounded-xl border border-border shadow-sm">
            <AppSidebar
              sections={shellSections}
              activeId="launch-poster"
              pendingApprovals={2}
              user={{ name: 'Drew Stone', email: 'drew@tangle.tools' }}
              onNewChat={() => console.log('new-chat')}
              onSelectSession={(id) => console.log('select-session', id)}
              onToggleCollapse={() => console.log('toggle-collapse')}
              onOpenApprovals={() => console.log('open-approvals')}
              onOpenSettings={() => console.log('open-settings')}
              onOpenAccount={() => console.log('open-account')}
              {...variant.props}
            />
          </div>
        </div>
      ))}
    </div>
  ),
}

/** Phone: the sidebar is hidden below `md` and the header's panel button opens
 *  it as a drawer (tap it — the drawer is live local state, like production). */
export const Mobile: Story = {
  name: 'Mobile viewport',
  globals: { viewport: { value: 'mobile2', isRotated: false } },
  render: (args) => <ShellScene args={args} messages={chatThread} />,
}
