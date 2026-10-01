// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { LineSetup } from '../src/hosted-agent/react/LineSetup'
import { ApplicationLineSetup } from '../src/hosted-agent/react/ApplicationLineSetup'
import type { ApplicationLineSetupClient, ApplicationSenderVerification, LineSetupSnapshot } from '../src/hosted-agent/react'

const expiresAt = () => new Date(Date.now() + 10 * 60_000).toISOString()
const testId = 'lsv_story_test'
const lineId = 'ln_demo'

function verification(state: ApplicationSenderVerification['state']): ApplicationSenderVerification {
  return {
    lineId, testId, state, expiresAt: expiresAt(),
    proof: {
      signedInboundTestAt: state === 'awaiting_test' ? null : new Date().toISOString(),
      providerReplyAcknowledgedAt: state === 'awaiting_test' ? null : new Date().toISOString(),
      signedInboundConfirmAt: state === 'verified' ? new Date().toISOString() : null,
    },
  }
}

describe('application line setup', () => {
  it('requires a signed phone proof before attach, then saves, reopens and disconnects', async () => {
    const user = userEvent.setup()
    let lines: LineSetupSnapshot['lines'] = []
    let proofState: ApplicationSenderVerification['state'] = 'challenge_sent'
    const client: ApplicationLineSetupClient = {
      load: async () => ({
        workspaceName: 'Research',
        targets: [{ id: 'thread_demo', label: 'Research conversation', kind: 'box', modes: ['shared'] }],
        connections: [
          { id: 'conn_demo', label: 'Owned Inkbox', providerId: 'inkbox',
            identities: [{ kind: 'handle', transport: 'imessage', label: '@research' }] },
          { id: 'conn_email', label: 'Owned mailbox', providerId: 'inkbox',
            identities: [{ kind: 'email', transport: 'email', label: 'mail@example.com' }] },
        ],
        lines,
      }),
      startSenderVerification: vi.fn(async input => {
        expect(input).toEqual({ connectionId: 'conn_demo', transport: 'imessage',
          targetId: 'thread_demo', boxMode: 'shared' })
        return { lineId, testId, state: 'awaiting_test' as const, testText: 'TEST ABC123', expiresAt: expiresAt() }
      }),
      getSenderVerification: vi.fn(async (requestedLine, requestedTest) => {
        expect([requestedLine, requestedTest]).toEqual([lineId, testId])
        return { ...verification(proofState), approvedSender: '+15550100001' }
      }),
      connect: vi.fn(async input => {
        expect(input).toEqual({ connectionId: 'conn_demo', transport: 'imessage',
          targetId: 'thread_demo', boxMode: 'shared', senderVerificationId: testId, turnsPerDay: 8 })
        lines = [{ id: lineId, attachmentId: 'lat_demo', connectionId: 'conn_demo',
          transport: 'imessage', address: '@research', connect: 'connect @research',
          routerAddress: '+15550100002', providerNumberId: null, status: 'active',
          answering: true, canDisconnect: true, targetId: 'thread_demo',
          targetLabel: 'Research conversation', boxMode: 'shared',
          lastTurn: { kind: 'none' } }]
      }),
      disconnect: vi.fn(async (requestedLine, attachmentId) => {
        expect([requestedLine, attachmentId]).toEqual([lineId, 'lat_demo'])
        lines = []
      }),
    }

    const view = render(<ApplicationLineSetup client={client} scopeKey="owner:workspace" canManage enabled />)
    const connect = await screen.findByRole('button', { name: 'Connect iMessage' })
    expect((connect as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Connect Email' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Authorized sender' })).toBeNull()
    await user.clear(screen.getByRole('spinbutton', { name: 'Maximum messages per day' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Maximum messages per day' }), '8')
    await user.click(screen.getByRole('button', { name: 'Start phone test' }))
    expect(await screen.findByText('TEST ABC123')).toBeTruthy()
    expect((connect as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Check verification' }))
    expect(await screen.findByText(/Confirmation sent/)).toBeTruthy()
    expect((connect as HTMLButtonElement).disabled).toBe(true)
    proofState = 'verified'
    await user.click(screen.getByRole('button', { name: 'Check verification' }))
    expect(await screen.findByText('Phone verified. You can connect this line.')).toBeTruthy()
    expect(screen.queryByText('+15550100001')).toBeNull()
    expect((connect as HTMLButtonElement).disabled).toBe(false)
    await user.click(connect)
    await waitFor(() => expect(client.connect).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Research conversation · shared box')).toBeTruthy()

    view.unmount()
    render(<ApplicationLineSetup client={client} scopeKey="owner:workspace" canManage enabled={false} />)
    expect(await screen.findByText('Research conversation · shared box')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('New connections are disabled')
    await user.click(screen.getByRole('button', { name: 'Disconnect line' }))
    await user.click(screen.getByRole('button', { name: /^Disconnect$/ }))
    await waitFor(() => expect(client.disconnect).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('No lines connected')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Connect iMessage' })).toBeNull()
  })

  it('does not carry proof to another selected line', async () => {
    const user = userEvent.setup()
    const client: ApplicationLineSetupClient = {
      load: async () => ({
        workspaceName: 'Research', lines: [],
        targets: [{ id: 'thread_demo', label: 'Research conversation', kind: 'box', modes: ['shared'] }],
        connections: [
          { id: 'conn_a', label: 'Line A', providerId: 'inkbox',
            identities: [{ kind: 'handle', transport: 'imessage', label: '@a' }] },
          { id: 'conn_b', label: 'Line B', providerId: 'inkbox',
            identities: [{ kind: 'handle', transport: 'imessage', label: '@b' }] },
        ],
      }),
      startSenderVerification: vi.fn(async () => ({
        lineId, testId, state: 'awaiting_test' as const, testText: 'TEST ABC123', expiresAt: expiresAt(),
      })),
      getSenderVerification: vi.fn(async () => verification('verified')),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
    }
    render(<ApplicationLineSetup client={client} scopeKey="owner:workspace" canManage enabled />)
    const connect = await screen.findByRole('button', { name: 'Connect iMessage' })
    await user.click(screen.getByRole('button', { name: 'Start phone test' }))
    await user.click(await screen.findByRole('button', { name: 'Check verification' }))
    expect(await screen.findByText('Phone verified. You can connect this line.')).toBeTruthy()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Owned connection' }), 'conn_b:0')
    expect((connect as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('Phone verified. You can connect this line.')).toBeNull()
    await user.click(connect)
    expect(client.connect).not.toHaveBeenCalled()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Owned connection' }), 'conn_a:0')
    expect((connect as HTMLButtonElement).disabled).toBe(false)
  })

  it('refuses a status that expires before connection', async () => {
    const user = userEvent.setup()
    const client: ApplicationLineSetupClient = {
      load: async () => ({
        workspaceName: 'Research', lines: [],
        targets: [{ id: 'thread_demo', label: 'Research conversation', kind: 'box', modes: ['shared'] }],
        connections: [{ id: 'conn_demo', label: 'Owned Inkbox', providerId: 'inkbox',
          identities: [{ kind: 'handle', transport: 'imessage', label: '@research' }] }],
      }),
      startSenderVerification: vi.fn(async () => ({
        lineId, testId, state: 'awaiting_test' as const, testText: 'TEST ABC123', expiresAt: expiresAt(),
      })),
      getSenderVerification: vi.fn(async () => ({
        ...verification('verified'), expiresAt: new Date(Date.now() - 1_000).toISOString(),
      })),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
    }
    render(<ApplicationLineSetup client={client} scopeKey="owner:workspace" canManage enabled />)
    const connect = await screen.findByRole('button', { name: 'Connect iMessage' })
    await user.click(screen.getByRole('button', { name: 'Start phone test' }))
    await user.click(await screen.findByRole('button', { name: 'Check verification' }))
    expect(await screen.findByText('This phone test can no longer connect the line. Start a new test.')).toBeTruthy()
    expect((connect as HTMLButtonElement).disabled).toBe(true)
    await user.click(connect)
    expect(client.connect).not.toHaveBeenCalled()
  })

  it('recovers when another tab consumes a verified proof and a refresh fails', async () => {
    const user = userEvent.setup()
    let remoteState: ApplicationSenderVerification['state'] = 'verified'
    let refreshFails = false
    const client: ApplicationLineSetupClient = {
      load: async () => ({
        workspaceName: 'Research', lines: [],
        targets: [{ id: 'thread_demo', label: 'Research conversation', kind: 'box', modes: ['shared'] }],
        connections: [{ id: 'conn_demo', label: 'Owned Inkbox', providerId: 'inkbox',
          identities: [{ kind: 'handle', transport: 'imessage', label: '@research' }] }],
      }),
      startSenderVerification: vi.fn(async () => ({
        lineId, testId, state: 'awaiting_test' as const, testText: 'TEST ABC123', expiresAt: expiresAt(),
      })),
      getSenderVerification: vi.fn(async () => {
        if (refreshFails) throw new Error('Status unavailable')
        return verification(remoteState)
      }),
      connect: vi.fn(async () => { throw new Error('Proof consumed by another tab') }),
      disconnect: vi.fn(async () => {}),
    }
    render(<ApplicationLineSetup client={client} scopeKey="owner:workspace" canManage enabled />)
    const connect = await screen.findByRole('button', { name: 'Connect iMessage' }) as HTMLButtonElement
    await user.click(screen.getByRole('button', { name: 'Start phone test' }))
    await user.click(await screen.findByRole('button', { name: 'Check verification' }))
    expect(await screen.findByText('Phone verified. You can connect this line.')).toBeTruthy()
    expect(connect.disabled).toBe(false)

    remoteState = 'consumed'
    await user.click(connect)
    expect((await screen.findByRole('alert')).textContent).toContain('Proof consumed by another tab')
    await waitFor(() => expect(connect.disabled).toBe(true))
    expect(screen.getByText('Check verification again before connecting.')).toBeTruthy()
    refreshFails = true
    await user.click(screen.getByRole('button', { name: 'Check verification' }))
    expect((await screen.findByText('Status unavailable')).textContent).toContain('Status unavailable')
    expect(connect.disabled).toBe(true)

    refreshFails = false
    await user.click(screen.getByRole('button', { name: 'Check verification' }))
    expect(await screen.findByText('This phone test can no longer connect the line. Start a new test.')).toBeTruthy()
    expect(connect.disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Start phone test' }))
    await waitFor(() => expect(client.startSenderVerification).toHaveBeenCalledTimes(2))
  })
})

it('keeps the confirmed attachment after refreshing a replacement into the list', async () => {
  const user = userEvent.setup()
  let attachmentId = 'lat_original'
  const load = vi.fn(async (): Promise<LineSetupSnapshot> => ({
    workspaceName: 'Workspace', connections: null, targets: [],
    lines: [{ id: 'ln_demo', attachmentId, connectionId: 'connection', transport: 'imessage',
      address: '@demo', connect: null, routerAddress: null, providerNumberId: null,
      status: 'active', answering: true, canDisconnect: true, targetId: 'thread',
      targetLabel: attachmentId, boxMode: 'shared', lastTurn: { kind: 'none' } }],
  }))
  const disconnect = vi.fn(async (_line: string, expected?: string) => {
    if (expected !== attachmentId) throw new Error('Attachment changed; reload before disconnecting')
  })
  render(<LineSetup scopeKey="owner:workspace" canManage client={{ load, disconnect, connect: async () => {} }} />)
  await user.click(await screen.findByRole('button', { name: 'Disconnect line' }))
  attachmentId = 'lat_replacement'
  await user.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('lat_replacement · shared box')
  await user.click(screen.getByRole('button', { name: /^Disconnect$/ }))
  await waitFor(() => expect(disconnect).toHaveBeenCalledWith('ln_demo', 'lat_original'))
  expect((await screen.findByRole('alert')).textContent).toContain('Attachment changed')
  await user.click(screen.getByRole('button', { name: 'Keep line' }))
  await user.click(screen.getByRole('button', { name: 'Disconnect line' }))
  await user.click(screen.getByRole('button', { name: /^Disconnect$/ }))
  await waitFor(() => expect(disconnect).toHaveBeenLastCalledWith('ln_demo', 'lat_replacement'))
})
