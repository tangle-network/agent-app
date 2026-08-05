import type { Meta, StoryObj } from '@storybook/react'
import { type ReactNode, useEffect } from 'react'
import {
  AssistantClientProvider,
  AssistantDock,
  AssistantLauncherProvider,
  useAssistantLauncher,
} from '../../assistant'
import { STORY_USER_ID, stubClient, useStubAttachments } from './fixtures'

/**
 * The floating launcher + right-side drawer, mounted over a fake page so the
 * overlay, focus trap, and resize handle read in context. The dock owns the
 * real `useAssistantChat`, streaming through the stub client — sending a
 * message replays a scripted turn (reasoning → tool chip → answer → proposal
 * card → cost), and Confirm resolves it.
 */
const meta: Meta<typeof AssistantDock> = {
  title: 'Assistant/Dock',
  component: AssistantDock,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <AssistantClientProvider client={stubClient}>
        <AssistantLauncherProvider>
          <Story />
        </AssistantLauncherProvider>
      </AssistantClientProvider>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof AssistantDock>

/** A minimal app-shell stand-in for the dock to float over. */
function FakePage() {
  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-4 border-border border-b px-4">
        <span className="font-semibold text-foreground text-sm">Agent</span>
        <span className="text-muted-foreground text-sm">Workflows</span>
      </div>
      <div className="p-6">
        <h1 className="font-medium text-foreground text-xl">Workflows</h1>
        <p className="mt-2 max-w-md text-muted-foreground text-sm">
          The assistant dock floats above every page. Open it from the launcher
          in the corner; the conversation survives the drawer closing.
        </p>
      </div>
    </div>
  )
}

/** Calls `openAssistant` once on mount (optionally with a composer seed) so a
 *  story can start with the drawer already open. Must render inside the
 *  launcher provider — the meta decorator supplies it. */
function OpenOnMount({ seed, children }: { seed?: string; children: ReactNode }) {
  const { openAssistant } = useAssistantLauncher()
  useEffect(() => {
    openAssistant(seed)
  }, [openAssistant, seed])
  return <>{children}</>
}

/** Closed: just the floating launcher over the page. Click it to open the
 *  drawer. */
export const DockCollapsed: Story = {
  name: 'Collapsed (launcher)',
  render: () => (
    <>
      <FakePage />
      <AssistantDock
        userId={STORY_USER_ID}
        navigate={(path) => console.log('[story] navigate', path)}
        balanceUsd={12.4}
        onWorkflowMutation={() => console.log('[story] workflow mutated')}
      />
    </>
  ),
}

/** Open on load: the drawer with a fresh, empty conversation. Escape, the
 *  backdrop, or the X closes it; the left edge drag-resizes on desktop. */
export const DockExpanded: Story = {
  name: 'Expanded',
  render: () => (
    <>
      <FakePage />
      <OpenOnMount>
        <AssistantDock
          userId={STORY_USER_ID}
          navigate={(path) => console.log('[story] navigate', path)}
          balanceUsd={12.4}
          onWorkflowMutation={() => console.log('[story] workflow mutated')}
          onConnectRequirement={async (requirement) => {
            console.log('[story] connect requirement', requirement.provider)
            return { connected: true }
          }}
        />
      </OpenOnMount>
    </>
  ),
}

/** The launcher seed path: a page-level "Create with assistant" action opens
 *  the drawer with the composer prefilled (consume-once). */
export const DockWithSeed: Story = {
  name: 'Expanded with Composer Seed',
  render: () => (
    <>
      <FakePage />
      <OpenOnMount seed="Create a workflow that posts the launch poster every Monday morning">
        <AssistantDock
          userId={STORY_USER_ID}
          navigate={(path) => console.log('[story] navigate', path)}
          balanceUsd={12.4}
        />
      </OpenOnMount>
    </>
  ),
}

/** The composer attachments seam end-to-end: the dock forwards the host's
 *  attachment props to the panel's composer — the attach button, staged chips
 *  flipping uploading → ready (stubbed), cleared on send. */
export const DockWithAttachments: Story = {
  name: 'Expanded with Attachments',
  render: () => <DockAttachments />,
}

function DockAttachments() {
  const stub = useStubAttachments()
  return (
    <>
      <FakePage />
      <OpenOnMount>
        <AssistantDock
          userId={STORY_USER_ID}
          navigate={(path) => console.log('[story] navigate', path)}
          balanceUsd={12.4}
          composerAttachments={stub.attachments}
          onComposerSend={stub.onSend}
        />
      </OpenOnMount>
    </>
  )
}
