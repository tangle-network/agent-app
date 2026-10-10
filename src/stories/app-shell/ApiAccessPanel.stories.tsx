import type { Meta, StoryObj } from '@storybook/react'
import { ApiAccessPanel } from '../../web-react/api-access-panel'

const meta: Meta<typeof ApiAccessPanel> = {
  title: 'App Shell/API access',
  component: ApiAccessPanel,
  parameters: { layout: 'fullscreen' },
  args: {
    keys: [],
    access: [
      { scope: 'records:read', label: 'Read records', description: 'Read your records and run status.' },
      { scope: 'records:write', label: 'Edit records', description: 'Create and edit your records.' },
      { scope: 'records:run', label: 'Run agents', description: 'Requires read access.', requires: ['records:read'] },
    ],
    defaultScopes: ['records:read'],
    baseUrl: 'https://example.test',
    accountHref: '#account',
    onCreate: async () => ({ id: 'fixture', key: 'synthetic-story-key-not-a-credential' }),
    onRevoke: async () => {},
    onChanged: () => {},
  },
}
export default meta

type Story = StoryObj<typeof ApiAccessPanel>
export const Empty: Story = {}
export const ExistingKeys: Story = {
  args: { keys: [
    { id: 'existing', name: 'My server', scopes: ['records:read'], expiresAt: '2030-01-01' },
    { id: 'expired', name: 'Old client', scopes: ['records:write'], expiresAt: '2020-01-01' },
  ] },
}
/** A product whose keys can be limited to one workspace: the limit sits in the form, and each key says what it reaches. */
export const WorkspaceLimits: Story = {
  args: {
    workspaces: [{ id: 'ws-studio', name: 'Research studio' }, { id: 'ws-office', name: 'Home office' }],
    workspaceNoun: { singular: 'project', plural: 'projects' },
    keys: [
      { id: 'everywhere', name: 'Claude Code', scopes: ['records:read', 'records:run'], expiresAt: '2030-01-01' },
      { id: 'studio', name: 'Studio bot', scopes: ['records:read'], expiresAt: '2030-01-01', workspaceIds: ['ws-studio'] },
    ],
  },
}
export const CreationFailure: Story = {
  args: { onCreate: async () => { throw new Error('Key store unavailable') } },
}
