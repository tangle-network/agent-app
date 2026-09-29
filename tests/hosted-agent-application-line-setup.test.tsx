// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApplicationLineSetup } from '../src/hosted-agent/react/ApplicationLineSetup'
import type { ApplicationLineSetupClient, LineSetupSnapshot } from '../src/hosted-agent/react'

describe('application line setup', () => {
  it('saves and reopens a line, then disconnects it while new grants are disabled', async () => {
    const user = userEvent.setup()
    let lines: LineSetupSnapshot['lines'] = []
    const client: ApplicationLineSetupClient = {
      load: async () => ({
        workspaceName: 'Research',
        targets: [{ id: 'thread_demo', label: 'Research conversation', kind: 'box', modes: ['shared'] }],
        connections: [{ id: 'conn_demo', label: 'Owned Inkbox', providerId: 'inkbox',
          identities: [{ kind: 'handle', transport: 'imessage', label: '@research' }] }],
        lines,
      }),
      connect: vi.fn(async input => {
        expect(input).toEqual({ connectionId: 'conn_demo', transport: 'imessage',
          targetId: 'thread_demo', boxMode: 'shared', operatorAddress: '+15550100001', turnsPerDay: 8 })
        lines = [{ id: 'ln_demo', attachmentId: 'lat_demo', connectionId: 'conn_demo',
          transport: 'imessage', address: '@research', connect: 'connect @research',
          routerAddress: '+15550100002', providerNumberId: null, status: 'active',
          answering: true, canDisconnect: true, targetId: 'thread_demo',
          targetLabel: 'Research conversation · +15550100001', boxMode: 'shared',
          lastTurn: { kind: 'none' } }]
      }),
      disconnect: vi.fn(async (lineId, attachmentId) => {
        expect([lineId, attachmentId]).toEqual(['ln_demo', 'lat_demo'])
        lines = []
      }),
    }
    const view = render(<ApplicationLineSetup client={client} scopeKey="owner:workspace" canManage enabled />)
    const connect = await screen.findByRole('button', { name: 'Connect iMessage' })
    expect((connect as HTMLButtonElement).disabled).toBe(true)
    await user.type(screen.getByRole('textbox', { name: 'Authorized sender' }), '+15550100001')
    await user.clear(screen.getByRole('spinbutton', { name: 'Maximum messages per day' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Maximum messages per day' }), '8')
    await user.click(screen.getByRole('checkbox', { name: /I authorize this sender/ }))
    await user.click(connect)
    await waitFor(() => expect(client.connect).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/Research conversation · \+15550100001/)).toBeTruthy()
    view.unmount()
    render(<ApplicationLineSetup client={client} scopeKey="owner:workspace" canManage enabled={false} />)
    expect(await screen.findByText(/Research conversation · \+15550100001/)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('New connections are disabled')
    await user.click(screen.getByRole('button', { name: 'Disconnect line' }))
    await user.click(screen.getByRole('button', { name: /^Disconnect$/ }))
    await waitFor(() => expect(client.disconnect).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('No lines connected')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Connect iMessage' })).toBeNull()
  })
})
