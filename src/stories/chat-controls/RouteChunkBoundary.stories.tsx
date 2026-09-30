import type { Meta, StoryObj } from '@storybook/react'

import { RouteChunkBoundary } from '../../web-react'

function FailedRoute(): never {
  throw new TypeError('Failed to fetch dynamically imported module: https://app.example/assets/WorkspaceAppsView-oldhash.js')
}

const meta: Meta<typeof RouteChunkBoundary> = {
  title: 'ChatControls/RouteChunkBoundary',
  component: RouteChunkBoundary,
  parameters: { layout: 'centered' },
  decorators: [(Story) => <div className="w-[420px] max-w-full p-4"><Story /></div>],
}

export default meta
type Story = StoryObj<typeof RouteChunkBoundary>

export const LoadFailure: Story = {
  parameters: { docs: { description: { story: 'A stale route chunk leaves a recovery action that requests the current document.' } } },
  render: () => <RouteChunkBoundary><FailedRoute /></RouteChunkBoundary>,
}

export const Loaded: Story = {
  render: () => <RouteChunkBoundary><div className="rounded-xl border border-border bg-card p-5">Route loaded</div></RouteChunkBoundary>,
}
