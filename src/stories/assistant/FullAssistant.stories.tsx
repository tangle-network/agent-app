import type { Meta, StoryObj } from '@storybook/react'
import { useEffect } from 'react'
import {
  AssistantClientProvider,
  AssistantDock,
  AssistantLauncherProvider,
  useAssistantLauncher,
} from '../../assistant'
import { STORY_USER_ID, stubClient } from './fixtures'

/**
 * The whole assistant surface at app-shell scale: the dock mounted over a fake
 * Workflows page, opened from the corner launcher or the page's "Create with
 * assistant" button (which seeds the composer). Sending a message replays the
 * stub client's scripted turn live — reasoning, a tool chip, the answer, a
 * workflow proposal with a connectable requirement, then the settled cost —
 * and Confirm resolves the card. This is the story to judge the assistant as
 * a product surface rather than a set of parts.
 */
const meta: Meta<typeof AssistantDock> = {
  title: 'Assistant/FullAssistant',
  component: AssistantDock,
  parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj<typeof AssistantDock>

/** Stand-in workflow-graph renderer for the live proposal card. */
const renderGraph = (_yaml: string) => (
  <div className="flex h-full flex-col items-center justify-center gap-2 bg-muted/30 p-3">
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

const NAV_ITEMS = ['Chat', 'Workflows', 'Approvals', 'Integrations', 'Billing']

/** A fake Workflows page with the launcher-driven CTA. */
function AppShell() {
  const { openAssistant } = useAssistantLauncher()
  return (
    <div className="flex h-screen bg-background">
      <aside className="flex w-52 shrink-0 flex-col gap-0.5 border-border border-r p-3">
        <span className="px-2 pt-1 pb-3 font-semibold text-foreground text-sm">
          Agent
        </span>
        {NAV_ITEMS.map((item) => (
          <span
            key={item}
            className={`rounded-md px-2 py-1.5 text-sm ${
              item === 'Workflows'
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground'
            }`}
          >
            {item}
          </span>
        ))}
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-border border-b px-5">
          <span className="font-medium text-foreground text-sm">Workflows</span>
          <button
            type="button"
            onClick={() =>
              openAssistant(
                'Create a workflow that posts the launch poster every Monday morning',
              )
            }
            className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground text-xs transition hover:opacity-90"
          >
            Create with assistant
          </button>
        </header>
        <div className="p-6">
          <h1 className="font-medium text-foreground text-lg">Your workflows</h1>
          <p className="mt-1 max-w-lg text-muted-foreground text-sm">
            Open the assistant from the corner launcher, or use “Create with
            assistant” to start with a seeded composer. Send the message to
            watch a scripted turn stream in, then confirm the proposed workflow.
          </p>
          <div className="mt-6 flex max-w-lg flex-col gap-2">
            {['launch-poster render', 'weekly metrics digest', 'churn-risk sweep'].map(
              (name) => (
                <div
                  key={name}
                  className="flex items-center justify-between rounded-lg border border-border px-4 py-3"
                >
                  <span className="text-foreground text-sm">{name}</span>
                  <span className="text-muted-foreground text-xs">active</span>
                </div>
              ),
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

/** Opens the drawer once on mount. Must render inside the launcher provider. */
function OpenOnMount() {
  const { openAssistant } = useAssistantLauncher()
  useEffect(() => {
    openAssistant()
  }, [openAssistant])
  return null
}

function Docked() {
  return (
    <AssistantClientProvider client={stubClient}>
      <AssistantLauncherProvider>
        <AppShell />
        <AssistantDock
          userId={STORY_USER_ID}
          navigate={(path) => console.log('[story] navigate', path)}
          balanceUsd={12.4}
          renderGraph={renderGraph}
          onWorkflowMutation={() => console.log('[story] workflow mutated')}
          onConnectRequirement={async (requirement) => {
            console.log('[story] connect requirement', requirement.provider)
            return { connected: true }
          }}
        />
      </AssistantLauncherProvider>
    </AssistantClientProvider>
  )
}

/** The dock over the app shell, closed — open it from the launcher or the
 *  seeded CTA. */
export const FullAssistant: Story = {
  name: 'Full Assistant (closed)',
  render: () => <Docked />,
}

/** Same composition with the drawer already open. */
export const FullAssistantOpen: Story = {
  name: 'Full Assistant (open)',
  render: () => (
    <AssistantClientProvider client={stubClient}>
      <AssistantLauncherProvider>
        <OpenOnMount />
        <AppShellWithDock />
      </AssistantLauncherProvider>
    </AssistantClientProvider>
  ),
}

function AppShellWithDock() {
  return (
    <>
      <AppShell />
      <AssistantDock
        userId={STORY_USER_ID}
        navigate={(path) => console.log('[story] navigate', path)}
        balanceUsd={12.4}
        renderGraph={renderGraph}
        onWorkflowMutation={() => console.log('[story] workflow mutated')}
        onConnectRequirement={async (requirement) => {
          console.log('[story] connect requirement', requirement.provider)
          return { connected: true }
        }}
      />
    </>
  )
}
