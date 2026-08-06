import type { Meta, StoryObj } from '@storybook/react'
import type { ReactNode } from 'react'
import { AssistantHistory } from '../../assistant/AssistantHistory'
import { threadSummaries } from './fixtures'

/**
 * The panel's full-screen conversation history (behind the header's history
 * toggle): searchable, recency-sorted, with inline delete. Presentational —
 * selection and deletion log to the console; search works via the component's
 * own state.
 */
const meta: Meta<typeof AssistantHistory> = {
  title: 'Assistant/History',
  component: AssistantHistory,
  parameters: { layout: 'centered' },
}

export default meta
type Story = StoryObj<typeof AssistantHistory>

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="h-[560px] w-[400px] overflow-hidden rounded-lg border border-border">
      {children}
    </div>
  )
}

const log = {
  onSelect: (threadId: string) => console.log('[story] select thread', threadId),
  onDelete: (threadId: string) => console.log('[story] delete thread', threadId),
  error: null as string | null,
  onRetry: () => console.log('[story] retry load'),
}

/** Populated: the active conversation highlighted, relative timestamps, a null
 *  title rendered as "Untitled conversation", delete on hover. */
export const HistoryPopulated: Story = {
  name: 'Populated',
  render: () => (
    <Frame>
      <AssistantHistory
        threads={threadSummaries}
        loaded
        activeThreadId="t-poster"
        activeBusy={false}
        canRemove
        {...log}
      />
    </Frame>
  ),
}

/** Loaded with no past conversations. */
export const HistoryEmpty: Story = {
  name: 'Empty',
  render: () => (
    <Frame>
      <AssistantHistory
        threads={[]}
        loaded
        activeThreadId={null}
        activeBusy={false}
        canRemove
        {...log}
      />
    </Frame>
  ),
}

/** Before the first fetch settles (the panel refreshes on open). */
export const HistoryLoading: Story = {
  name: 'Loading',
  render: () => (
    <Frame>
      <AssistantHistory
        threads={[]}
        loaded={false}
        activeThreadId={null}
        activeBusy={false}
        canRemove
        {...log}
      />
    </Frame>
  ),
}

/** The thread fetch failed: the error branch renders the reason and wires the
 *  retry button to onRetry (loaded stays false — error never reads as empty). */
export const HistoryLoadError: Story = {
  name: 'Load Error',
  render: () => (
    <Frame>
      <AssistantHistory
        threads={[]}
        loaded={false}
        activeThreadId={null}
        activeBusy={false}
        canRemove
        {...log}
        error="Couldn't load conversations — the assistant service is unreachable."
      />
    </Frame>
  ),
}

/** The active conversation mid-turn: its delete is disabled, the others stay
 *  removable. */
export const HistoryActiveBusy: Story = {
  name: 'Active Thread Busy',
  render: () => (
    <Frame>
      <AssistantHistory
        threads={threadSummaries}
        loaded
        activeThreadId="t-poster"
        activeBusy
        canRemove
        {...log}
      />
    </Frame>
  ),
}

/** A transport without a delete endpoint: no delete affordance at all. */
export const HistoryNoDelete: Story = {
  name: 'No Delete Support',
  render: () => (
    <Frame>
      <AssistantHistory
        threads={threadSummaries}
        loaded
        activeThreadId={null}
        activeBusy={false}
        canRemove={false}
        {...log}
      />
    </Frame>
  ),
}

/** The history view's states side by side. */
export const HistoryStates: Story = {
  name: 'All States',
  parameters: { layout: 'padded' },
  render: () => (
    <div className="grid grid-cols-4 gap-4">
      {(
        [
          ['Populated', { threads: threadSummaries, loaded: true, canRemove: true }],
          ['Empty', { threads: [], loaded: true, canRemove: true }],
          ['Loading', { threads: [], loaded: false, canRemove: true }],
          ['No delete', { threads: threadSummaries, loaded: true, canRemove: false }],
        ] satisfies ReadonlyArray<
          readonly [
            string,
            {
              threads: typeof threadSummaries
              loaded: boolean
              canRemove: boolean
            },
          ]
        >
      ).map(([label, props]) => (
        <div key={label} className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">{label}</span>
          <div className="h-[420px] w-[300px] overflow-hidden rounded-lg border border-border">
            <AssistantHistory
              threads={props.threads}
              loaded={props.loaded}
              activeThreadId="t-poster"
              activeBusy={false}
              canRemove={props.canRemove}
              {...log}
            />
          </div>
        </div>
      ))}
    </div>
  ),
}
