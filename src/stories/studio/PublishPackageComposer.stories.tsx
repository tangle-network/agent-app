import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'
import { PublishPackageComposer } from '../../studio-react'
import type { IntegrationConnection } from '@tangle-network/sandbox-ui/integrations'
import { CADENCES } from '../../studio'
import { demoConnections } from './fixtures'

/**
 * Controlled staging form — each demo holds caption/description/mentions/
 * cadence/destinations in local state so toggles and edits stick. A router is
 * required for the "Connect" Link (only rendered with an integrationsHref and
 * manage permission).
 */
function PublishDemo({
  connections,
  connectionError = null,
  connectionsLoading = false,
  integrationsHref,
  canManageIntegrations,
  initialSelected = [],
}: {
  connections: IntegrationConnection[]
  connectionError?: Error | null
  connectionsLoading?: boolean
  integrationsHref?: string
  canManageIntegrations: boolean
  initialSelected?: string[]
}) {
  const [caption, setCaption] = useState('')
  const [postDescription, setPostDescription] = useState('')
  const [mentions, setMentions] = useState('')
  const [cadence, setCadence] = useState(CADENCES[0] ?? 'Manual approval')
  const [selectedDestinations, setSelectedDestinations] = useState<string[]>(initialSelected)
  return (
    <MemoryRouter>
      <PublishPackageComposer
        caption={caption}
        postDescription={postDescription}
        mentions={mentions}
        cadence={cadence}
        selectedDestinations={selectedDestinations}
        connections={connections}
        connectionError={connectionError}
        connectionsLoading={connectionsLoading}
        integrationsHref={integrationsHref}
        canManageIntegrations={canManageIntegrations}
        onCaptionChange={setCaption}
        onDescriptionChange={setPostDescription}
        onMentionsChange={setMentions}
        onCadenceChange={setCadence}
        onDestinationToggle={(destination) => {
          console.log('onDestinationToggle', destination)
          setSelectedDestinations((current) => current.includes(destination)
            ? current.filter((item) => item !== destination)
            : [...current, destination])
        }}
      />
    </MemoryRouter>
  )
}

const meta: Meta<typeof PublishPackageComposer> = {
  title: 'Studio/PublishPackageComposer',
  component: PublishPackageComposer,
  decorators: [
    (Story) => (
      <div className="w-[520px] p-4">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof PublishPackageComposer>

/** No connected apps — every destination is disabled with "Not connected". */
export const Default: Story = {
  render: () => <PublishDemo connections={[]} canManageIntegrations={false} />,
}

/** Instagram + X connected (X selected), manage permission → Connect button. */
export const Populated: Story = {
  render: () => (
    <PublishDemo
      connections={demoConnections}
      canManageIntegrations
      integrationsHref="/app/ws-demo/integrations"
      initialSelected={['x']}
    />
  ),
}

export const ConnectionsLoading: Story = {
  name: 'Connections loading',
  render: () => <PublishDemo connections={[]} connectionsLoading canManageIntegrations={false} />,
}

/** Hub fetch failed — warning banner replaces the helper copy. */
export const ConnectionsError: Story = {
  name: 'Connections error',
  render: () => (
    <PublishDemo
      connections={[]}
      connectionError={new Error('fetch failed')}
      canManageIntegrations
      integrationsHref="/app/ws-demo/integrations"
    />
  ),
}

/** The three connection states a reviewer has to judge at a glance. */
export const ConnectionStates: Story = {
  name: 'Connection states',
  render: () => (
    <div className="flex flex-col gap-10">
      <section>
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">Connected</p>
        <PublishDemo connections={demoConnections} canManageIntegrations integrationsHref="/app/ws-demo/integrations" initialSelected={['instagram']} />
      </section>
      <section>
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">None connected</p>
        <PublishDemo connections={[]} canManageIntegrations={false} />
      </section>
      <section>
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">Load error</p>
        <PublishDemo connections={[]} connectionError={new Error('fetch failed')} canManageIntegrations={false} />
      </section>
    </div>
  ),
}
