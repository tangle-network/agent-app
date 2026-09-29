import type { Meta, StoryObj } from '@storybook/react'
import { useMemo } from 'react'
import { ApplicationLineSetup } from '../../hosted-agent/react'
import type { ApplicationLineSetupClient, LineSetupLine, LineSetupSnapshot } from '../../hosted-agent/react'

const STORAGE_KEY = 'agent-app-application-line-story-v1'
const initial: LineSetupSnapshot = {
  workspaceName: 'Research workspace',
  lines: [],
  connections: [{ id: 'conn_email', label: 'Owned mailbox', providerId: 'inkbox',
    identities: [{ kind: 'email', transport: 'email', label: 'agent@example.com' }] }],
  targets: [{ id: 'thread_research', label: 'Research conversation', kind: 'box', modes: ['shared'] }],
}

function storedLine(): LineSetupLine | null {
  const raw = sessionStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    const line: unknown = JSON.parse(raw)
    if (typeof line === 'object' && line !== null && 'id' in line && line.id === 'ln_story')
      return line as LineSetupLine
  } catch { /* A stale fixture can be replaced by the next connect. */ }
  sessionStorage.removeItem(STORAGE_KEY)
  return null
}

function createClient(): ApplicationLineSetupClient {
  return {
    async load() { const line = storedLine(); return { ...initial, lines: line ? [line] : [] } },
    async connect(input) {
      if (input.connectionId !== 'conn_email' || input.targetId !== 'thread_research'
        || input.transport !== 'email' || input.boxMode !== 'shared')
        throw new Error('This fixture accepts only its listed conversation and mailbox')
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        id: 'ln_story', attachmentId: 'lat_story', connectionId: input.connectionId,
        transport: 'email', address: 'agent@example.com', connect: null,
        routerAddress: null, providerNumberId: null, status: 'active',
        answering: true, canDisconnect: true, targetId: input.targetId,
        targetLabel: `Research conversation · ${input.operatorAddress}`, boxMode: input.boxMode,
        lastTurn: { kind: 'none' },
      } satisfies LineSetupLine))
    },
    async disconnect(lineId, attachmentId) {
      if (lineId !== 'ln_story' || attachmentId !== 'lat_story')
        throw new Error('The attachment changed; reload before disconnecting')
      sessionStorage.removeItem(STORAGE_KEY)
    },
  }
}

function StoryFixture({ enabled }: { enabled: boolean }) {
  const client = useMemo(createClient, [])
  return <ApplicationLineSetup client={client} scopeKey="storybook:research-workspace"
    canManage enabled={enabled} />
}

const meta: Meta<typeof ApplicationLineSetup> = {
  title: 'Hosted agent/Lines/Application setup',
  component: ApplicationLineSetup,
  parameters: { layout: 'padded' },
  decorators: [(Story) => <div style={{ maxWidth: 760, padding: 16 }}><Story /></div>],
}
export default meta
type Story = StoryObj<typeof ApplicationLineSetup>

/** Connect a sample mailbox, then reload this browser tab to inspect the retained line. */
export const Interactive: Story = { render: () => <StoryFixture enabled /> }
/** Uses the same saved fixture and keeps the disconnect control available. */
export const GrantsDisabled: Story = { render: () => <StoryFixture enabled={false} /> }
