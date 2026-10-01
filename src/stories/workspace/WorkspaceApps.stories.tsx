import type { Meta, StoryObj } from '@storybook/react'
import { AppWindow, History, House } from 'lucide-react'
import { useState, type ComponentProps } from 'react'

import { AgentWorkspaceLayout } from '../../workspace-react'

function WorkspaceAppsStory() {
  const [apps, setApps] = useState([
    { id: 'inventory', name: 'Inventory' },
    { id: 'reservations', name: 'Reservations' },
    { id: 'schedule', name: 'Schedule' },
  ])
  const [activeAppId, setActiveAppId] = useState('inventory')
  const activeApp = apps.find((app) => app.id === activeAppId)
  const StoryLink = ({ href, to, prefetch, onClick, ...props }: ComponentProps<'a'> & { to?: string; prefetch?: string }) => {
    const destination = href ?? to ?? ''
    return (
      <a
        {...props}
        href={destination}
        data-prefetch={prefetch}
        onClick={(event) => {
          if (destination.startsWith('/app/ws_1/apps/')) {
            event.preventDefault()
            setActiveAppId(destination.slice('/app/ws_1/apps/'.length))
          }
          onClick?.(event)
        }}
      />
    )
  }
  return (
    <AgentWorkspaceLayout
      navItems={[{ id: 'home', label: 'Home', icon: House, href: '/app/ws_1' }]}
      apps={{
        icon: AppWindow,
        items: apps,
        hrefForApp: (id) => '/app/ws_1/apps/' + id,
        prefetch: 'intent',
      }}
      sessions={{
        icon: History,
        href: '/app/ws_1/history',
        hrefForSession: (id) => '/app/ws_1/chat/' + id,
        sessions: [],
      }}
      activeRoute={{
        pathname: '/app/ws_1/apps/' + activeAppId,
        base: '/app/ws_1',
        routes: [{ id: 'home', path: '/' }],
      }}
      LinkComponent={StoryLink}
      railHeaderContent={<span className="text-sm font-semibold">Workspace</span>}
    >
      <main className="min-h-screen bg-background p-8 text-foreground">
        <h1 className="text-2xl font-semibold">{activeApp?.name}</h1>
        <p className="mt-2 text-sm text-muted-foreground">An app built in this workspace.</p>
        <button
          type="button"
          className="mt-6 rounded-md border border-border px-3 py-2 text-sm"
          onClick={() => setApps((current) => [
            ...current,
            { id: 'orders-' + (current.length - 2), name: 'Orders ' + (current.length - 2) },
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
