import type { Meta, StoryObj } from '@storybook/react'
import { House } from 'lucide-react'

import { AgentWorkspaceLayout } from '../../workspace-react'

const mark = <span className="block h-5 w-5 rounded bg-primary" />

function RailIdentityStory({ name }: { name: string }) {
  return (
    <AgentWorkspaceLayout
      navItems={[{ id: 'home', label: 'Home', icon: House, href: '/app/ws_1' }]}
      activeRoute={{ pathname: '/app/ws_1', base: '/app/ws_1', routes: [{ id: 'home', path: '/' }] }}
      product={{ name: 'Hospitality', mark, href: '/app' }}
      workspace={{
        id: 'ws_1',
        name,
        options: [{ id: 'ws_1', name }, { id: 'ws_2', name: 'ReCenter Santa Teresa' }],
        hrefForWorkspace: (id) => '/app/' + id,
        listHref: '/app',
        createHref: '/app/new',
      }}
    >
      <main className="min-h-screen bg-background p-8 text-foreground">
        <p className="text-sm text-muted-foreground">
          A name that fits one line keeps the product beneath it. A longer name takes the second line, and the product
          moves to the tooltip.
        </p>
      </main>
    </AgentWorkspaceLayout>
  )
}

const meta: Meta<typeof RailIdentityStory> = {
  title: 'Workspace/Rail identity',
  component: RailIdentityStory,
}

export default meta
type Story = StoryObj<typeof RailIdentityStory>

export const ShortName: Story = { args: { name: 'Casa Azul' } }
export const NameNeedsTwoLines: Story = { args: { name: 'Operator QA 1011' } }
export const NameLongerThanTwoLines: Story = { args: { name: 'ReCenter Nosara Wellness Retreat and Guest Residences' } }
