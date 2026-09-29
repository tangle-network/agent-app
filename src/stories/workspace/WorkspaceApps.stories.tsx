import type { Meta, StoryObj } from '@storybook/react'
import { AppWindow, House } from 'lucide-react'
import { useState } from 'react'

import { AgentWorkspaceLayout } from '../../workspace-react'

function WorkspaceAppsStory() {
  const [apps, setApps] = useState([
    { id: 'inventory', name: 'Inventory' },
    { id: 'reservations', name: 'Reservations' },
    { id: 'schedule', name: 'Schedule' },
  ])
  return (
    <AgentWorkspaceLayout
      navItems={[{ id: 'home', label: 'Home', icon: House, href: '/app/ws_1' }]}
      apps={{
        icon: AppWindow,
        items: apps,
        hrefForApp: (id) => '/app/ws_1/apps/' + id,
      }}
      activeRoute={{
        pathname: '/app/ws_1/apps/inventory',
        base: '/app/ws_1',
        routes: [{ id: 'home', path: '/' }],
      }}
      railHeaderContent={<span className="text-sm font-semibold">Workspace</span>}
    >
      <main className="min-h-screen bg-background p-8 text-foreground">
        <h1 className="text-2xl font-semibold">Inventory</h1>
        <p className="mt-2 text-sm text-muted-foreground">An app built in this workspace.</p>
        <button
          type="button"
          className="mt-6 rounded-md border border-border px-3 py-2 text-sm"
          onClick={() => setApps((current) => [
            ...current,
            { id: 'orders', name: 'Orders' },
          ])}
        >
          Register another app
        </button>
      </main>
    </AgentWorkspaceLayout>
  )
}

const meta: Meta<typeof WorkspaceAppsStory> = {
  title: 'Workspace/Registered apps',
  component: WorkspaceAppsStory,
}

export default meta
type Story = StoryObj<typeof WorkspaceAppsStory>

export const MultipleApps: Story = {}
