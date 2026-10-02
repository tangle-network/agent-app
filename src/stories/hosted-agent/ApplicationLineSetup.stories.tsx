import type { Meta, StoryObj } from '@storybook/react'
import { expect, userEvent, within } from 'storybook/test'
import { useMemo } from 'react'
import { ApplicationLineSetup } from '../../hosted-agent/react'
import type { ApplicationLineSetupClient, ApplicationSenderVerification, LineSetupLine, LineSetupSnapshot } from '../../hosted-agent/react'

const STORAGE_KEY = 'agent-app-application-line-story-v2'
const WHATSAPP_STORAGE_KEY = 'agent-app-application-whatsapp-line-story-v1'
const expiresAt = () => new Date(Date.now() + 10 * 60_000).toISOString()
const initial: LineSetupSnapshot = {
  workspaceName: 'Research workspace',
  lines: [],
  connections: [{ id: 'conn_inkbox', label: 'Owned Inkbox', providerId: 'inkbox',
    identities: [{ kind: 'handle', transport: 'imessage', label: '@research' }] }],
  targets: [{ id: 'thread_research', label: 'Research conversation', kind: 'box', modes: ['shared'] }],
}

const attachedLine: LineSetupLine = {
  id: 'ln_story', attachmentId: 'lat_story', connectionId: 'conn_inkbox',
  transport: 'imessage', address: '@research', connect: 'connect @research',
  routerAddress: '+15550100002', providerNumberId: null, status: 'active',
  answering: true, canDisconnect: true, targetId: 'thread_research',
  targetLabel: 'Research conversation', boxMode: 'shared',
  lastTurn: { kind: 'none' },
}

const whatsAppInitial: LineSetupSnapshot = {
  ...initial,
  connections: [
    { id: 'conn_linq', label: 'Owned Linq', providerId: 'linq-whatsapp',
      identities: [{ kind: 'number', transport: 'whatsapp', label: '+1 555 0100', phoneNumberId: 'pn_owned' }] },
    { id: 'conn_other', label: 'Other provider', providerId: 'other-whatsapp',
      identities: [{ kind: 'number', transport: 'whatsapp', label: '+1 555 0199', phoneNumberId: 'pn_other' }] },
  ],
}
const whatsAppAttachedLine: LineSetupLine = {
  ...attachedLine, id: 'ln_whatsapp_story', attachmentId: 'lat_whatsapp_story', connectionId: 'conn_linq',
  transport: 'whatsapp', address: '+15550100', connect: 'connect +15550100',
  routerAddress: null, providerNumberId: 'pn_owned',
}

function storedLine(storageKey: string, expectedLineId: string): LineSetupLine | null {
  const raw = sessionStorage.getItem(storageKey)
  if (!raw) return null
  try {
    const line: unknown = JSON.parse(raw)
    if (typeof line === 'object' && line !== null && 'id' in line && line.id === expectedLineId)
      return line as LineSetupLine
  } catch { /* A stale fixture can be replaced by the next connect. */ }
  sessionStorage.removeItem(storageKey)
  return null
}

function status(state: ApplicationSenderVerification['state'], lineId: string): ApplicationSenderVerification {
  return {
    lineId, testId: 'lsv_story', state, expiresAt: expiresAt(),
    proof: {
      signedInboundTestAt: state === 'awaiting_test' ? null : new Date().toISOString(),
      providerReplyAcknowledgedAt: state === 'awaiting_test' ? null : new Date().toISOString(),
      signedInboundConfirmAt: state === 'verified' ? new Date().toISOString() : null,
    },
  }
}

type Mode = 'interactive' | 'whatsapp-interactive' | 'waiting' | 'verified' | 'stale-proof' | 'expired' | 'error' | 'attached' | 'dedicated' | 'no-identities' | 'inventory-error'

function createClient(mode: Mode): ApplicationLineSetupClient {
  let checks = 0
  const whatsApp = mode === 'whatsapp-interactive'
  const fixture = whatsApp ? whatsAppInitial : initial
  const fixtureLine = whatsApp ? whatsAppAttachedLine : attachedLine
  const storageKey = whatsApp ? WHATSAPP_STORAGE_KEY : STORAGE_KEY
  return {
    async load() {
      if (mode === 'inventory-error') throw new Error('HTTP 503: workspace messaging is unavailable')
      if (mode === 'no-identities') return { ...initial, connections: [] }
      if (mode === 'attached') return { ...initial, lines: [attachedLine] }
      if (mode === 'dedicated') return { ...initial, lines: [{ ...attachedLine,
        address: '+15550100003', connect: null, routerAddress: null }] }
      const line = mode === 'interactive' || whatsApp ? storedLine(storageKey, fixtureLine.id) : null
      return { ...fixture, lines: line ? [line] : [] }
    },
    async startSenderVerification(input) {
      if (input.connectionId !== fixtureLine.connectionId || input.transport !== fixtureLine.transport
        || input.phoneNumberId !== (fixtureLine.providerNumberId ?? undefined))
        throw new Error('Choose the owned line')
      return { lineId: fixtureLine.id, testId: 'lsv_story', state: 'awaiting_test',
        testText: 'TEST 482913', expiresAt: expiresAt() }
    },
    async getSenderVerification() {
      checks++
      if (mode === 'error') throw new Error('Verification is unavailable. Try again.')
      if (mode === 'expired') return status('expired', fixtureLine.id)
      if (mode === 'verified') return status('verified', fixtureLine.id)
      if (mode === 'stale-proof') return status(checks > 1 ? 'consumed' : 'verified', fixtureLine.id)
      return status(checks > 1 ? 'verified' : 'challenge_sent', fixtureLine.id)
    },
    async connect(input) {
      if (input.connectionId !== fixtureLine.connectionId || input.targetId !== 'thread_research'
        || input.transport !== fixtureLine.transport || input.phoneNumberId !== (fixtureLine.providerNumberId ?? undefined)
        || input.boxMode !== 'shared'
        || input.senderVerificationId !== 'lsv_story')
        throw new Error('This fixture accepts only its verified line and conversation')
      if (mode === 'stale-proof') throw new Error('Phone proof was used in another session')
      sessionStorage.setItem(storageKey, JSON.stringify(fixtureLine))
    },
    async disconnect(lineId, attachmentId) {
      if (lineId !== fixtureLine.id || attachmentId !== fixtureLine.attachmentId)
        throw new Error('The attachment changed; reload before disconnecting')
      sessionStorage.removeItem(storageKey)
    },
  }
}

function StoryFixture({ mode, enabled = true }: { mode: Mode; enabled?: boolean }) {
  const client = useMemo(() => createClient(mode), [mode])
  return <ApplicationLineSetup client={client} scopeKey={`storybook:research-workspace:${mode}`}
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

/** Run the TEST and private handset confirmation, connect, then reload and disconnect. */
export const Interactive: Story = { render: () => <StoryFixture mode="interactive" /> }

/** Mock owned Linq number; run TEST, connect, reload, and disconnect. */
export const WhatsAppInteractive: Story = { render: () => <StoryFixture mode="whatsapp-interactive" /> }

export const WaitingForPhone: Story = {
  render: () => <StoryFixture mode="waiting" />,
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: 'Start phone test' }))
  },
}

export const VerifiedPhone: Story = {
  render: () => <StoryFixture mode="verified" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole('button', { name: 'Start phone test' }))
    await userEvent.click(await canvas.findByRole('button', { name: 'Check verification' }))
  },
}

export const ConsumedPhoneProof: Story = {
  render: () => <StoryFixture mode="stale-proof" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole('button', { name: 'Start phone test' }))
    await userEvent.click(await canvas.findByRole('button', { name: 'Check verification' }))
    await userEvent.click(await canvas.findByRole('button', { name: 'Connect iMessage' }))
    await canvas.findByText('Check verification again before connecting.')
    await userEvent.click(await canvas.findByRole('button', { name: 'Check verification' }))
    await canvas.findByText('This phone test can no longer connect the line. Start a new test.')
  },
}

export const ExpiredPhoneTest: Story = {
  render: () => <StoryFixture mode="expired" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole('button', { name: 'Start phone test' }))
    await userEvent.click(await canvas.findByRole('button', { name: 'Check verification' }))
  },
}

export const VerificationError: Story = {
  render: () => <StoryFixture mode="error" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole('button', { name: 'Start phone test' }))
    await userEvent.click(await canvas.findByRole('button', { name: 'Check verification' }))
  },
}

export const Attached: Story = {
  render: () => <StoryFixture mode="attached" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const connect = await canvas.findByRole('link', { name: 'Connect iMessage' })
    await expect(connect.getAttribute('href')).toBe('sms:+15550100002?body=connect%20%40research')
    await expect(canvas.queryByRole('link', { name: 'Text it now' })).toBeNull()
  },
}
export const DedicatedNumber: Story = {
  render: () => <StoryFixture mode="dedicated" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const message = await canvas.findByRole('link', { name: 'Text it now' })
    await expect(message.getAttribute('href')).toBe('sms:+15550100003?body=Hello')
    await expect(canvas.queryByRole('link', { name: 'Connect iMessage' })).toBeNull()
  },
}
export const GrantsDisabled: Story = { render: () => <StoryFixture mode="attached" enabled={false} /> }
export const NoIdentities: Story = { render: () => <StoryFixture mode="no-identities" /> }
export const InventoryError: Story = { render: () => <StoryFixture mode="inventory-error" /> }
