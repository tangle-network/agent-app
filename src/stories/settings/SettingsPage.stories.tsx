import type { Meta, StoryObj } from '@storybook/react'
import { useMemo } from 'react'
import type { InvitationDelivery } from '../../teams/invitations'
import { createSettingsBackend, type ViewerRole } from './settings-backend'
import { SettingsDemo, type DemoSectionId } from './settings-demo'
import { SaveGroupDemo } from './save-group-demo'
import { TeamPanelsDemo } from './team-panels-demo'

/**
 * A whole project settings page from `settings-react`: one URL per section,
 * autosaving rows, confirmations for billed or destructive changes, one grouped
 * save bar, and the shared team, export and delete sections. Resize the canvas:
 * the section column becomes a tab strip below 60rem of content and rows stack
 * below 34rem of card.
 */
function Page({ viewer, section, delivery }: { viewer: ViewerRole; section: DemoSectionId; delivery?: InvitationDelivery }) {
  const backend = useMemo(() => createSettingsBackend({ viewer }), [viewer])
  return <SettingsDemo backend={backend} viewer={viewer} initialSection={section} delivery={delivery} />
}

const meta = {
  title: 'Settings/Settings page',
  component: Page,
  parameters: { layout: 'fullscreen' },
  args: { viewer: 'owner', section: 'general' },
  argTypes: {
    viewer: { control: 'inline-radio', options: ['owner', 'admin'] },
    section: { control: 'select', options: ['general', 'agent', 'notifications', 'limits', 'team'] },
    delivery: { control: 'inline-radio', options: ['email', 'link'] },
  },
} satisfies Meta<typeof Page>

export default meta
type Story = StoryObj<typeof meta>

/** The owner on General: name and timezone autosave, export runs as rows, delete asks for the name. */
export const General: Story = {}

/** An admin sees what only the owner may change, locked with the reason. */
export const AdminView: Story = { args: { viewer: 'admin', section: 'limits' } }

/** Members with capability roles; on a narrow card the role picker takes its own line. */
export const Team: Story = { args: { section: 'team' } }

/** A product that emails no invitations: Invite creates a link, shown with Copy link, and no row mentions email. */
export const TeamLinkOnly: Story = { args: { section: 'team', delivery: 'link' } }

/** The `teams-react` panels in their cards: below 36rem of card each role picker takes its own line and Remove stays beside the name. */
export const TeamPanels: Story = { render: () => <TeamPanelsDemo /> }

/** One save across several cards, as an agent profile's: the group bar follows the last card it saves and stays at the bottom of the screen while it has something to report. */
export const SaveGroup: Story = { render: () => <SaveGroupDemo /> }
