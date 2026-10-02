// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LineSetup } from './LineSetup'
import type { LineConnectInput, LineSetupSnapshot } from './contracts'

const singleChoice: LineSetupSnapshot = {
  workspaceName: 'Research workspace',
  lines: [],
  connections: [{
    id: 'conn_inkbox', label: 'Owned Inkbox', providerId: 'inkbox',
    identities: [{ kind: 'handle', transport: 'imessage', label: '@research' }],
  }],
  targets: [{ id: 'thread_research', label: 'Research conversation', kind: 'box', modes: ['shared'] }],
}

function setup(snapshot: LineSetupSnapshot) {
  const connect = vi.fn(async (_input: LineConnectInput) => {})
  render(<LineSetup scopeKey="research" canManage targetLabel="Conversation" client={{
    load: async () => snapshot,
    connect,
    disconnect: async () => {},
  }} />)
  return connect
}

describe('LineSetup choice display', () => {
  it('labels the shared entry point as a connection, never the agent direct number', async () => {
    setup({ ...singleChoice, lines: [{
      id: 'ln_shared', connectionId: 'conn_inkbox', transport: 'imessage', address: '@research',
      connect: 'connect @research', routerAddress: '+15550100002', providerNumberId: null,
      status: 'active', answering: true, canDisconnect: true, targetId: 'thread_research',
      targetLabel: 'Research conversation', boxMode: 'shared', lastTurn: { kind: 'none' },
    }] })
    const action = await screen.findByRole('link', { name: 'Connect iMessage' })
    expect(action.getAttribute('href')).toBe('sms:+15550100002?body=connect%20%40research')
    expect(screen.getByText('@research').tagName).toBe('STRONG')
    expect(screen.getByText(/Then message the number Inkbox sends you/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Text it now' })).toBeNull()
  })

  it('messages a dedicated number directly without sending a shared connect command', async () => {
    setup({ ...singleChoice, lines: [{
      id: 'ln_direct', connectionId: 'conn_inkbox', transport: 'imessage', address: '+15550100003',
      connect: null, routerAddress: null, providerNumberId: null,
      status: 'active', answering: true, canDisconnect: true, targetId: 'thread_research',
      targetLabel: 'Research conversation', boxMode: 'shared', lastTurn: { kind: 'none' },
    }] })
    expect((await screen.findByRole('link', { name: 'Text it now' })).getAttribute('href'))
      .toBe('sms:+15550100003?body=Hello')
    expect(screen.queryByRole('link', { name: 'Connect iMessage' })).toBeNull()
    expect(screen.queryByText(/Then message the number Inkbox sends you/)).toBeNull()
  })

  it.each([
    { connect: null, routerAddress: '+15550100002' },
    { connect: 'connect @research', routerAddress: null },
  ])('does not offer messaging from incomplete shared metadata: %j', async partial => {
    setup({ ...singleChoice, lines: [{
      id: 'ln_partial', connectionId: 'conn_inkbox', transport: 'imessage', address: '+15550100003',
      ...partial, providerNumberId: null, status: 'active', answering: true,
      canDisconnect: true, targetId: 'thread_research', targetLabel: 'Research conversation',
      boxMode: 'shared', lastTurn: { kind: 'none' },
    }] })
    await screen.findByText('Research conversation · shared box')
    expect(screen.queryByRole('link', { name: 'Connect iMessage' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Text it now' })).toBeNull()
  })

  it('shows the only identity and target as facts while keeping connect available', async () => {
    const connect = setup(singleChoice)
    const button = await screen.findByRole('button', { name: 'Connect iMessage' })

    expect(screen.queryByRole('heading', { name: 'Lines' })).toBeNull()
    expect(screen.queryByText('No lines connected')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('group', { name: 'Identity type' })).toBeNull()
    expect(screen.getByText('@research')).toBeTruthy()
    expect(screen.getByText('iMessage via Owned Inkbox')).toBeTruthy()
    expect(screen.getByText('Research conversation')).toBeTruthy()

    fireEvent.click(button)
    await waitFor(() => expect(connect).toHaveBeenCalledWith({
      connectionId: 'conn_inkbox', transport: 'imessage', targetId: 'thread_research', boxMode: 'shared',
    }))
  })

  it('keeps both choices editable when the host offers several', async () => {
    const connect = setup({
      ...singleChoice,
      connections: [
        { id: 'conn_inkbox', label: 'Research Inkbox', providerId: 'inkbox',
          identities: [{ kind: 'handle', transport: 'imessage', label: '@research' }] },
        { id: 'conn_support', label: 'Support Inkbox', providerId: 'inkbox',
          identities: [{ kind: 'handle', transport: 'imessage', label: '@support' }] },
      ],
      targets: [
        singleChoice.targets[0]!,
        { id: 'thread_support', label: 'Support conversation', kind: 'box', modes: ['shared'] },
      ],
    })
    await screen.findByRole('button', { name: 'Connect iMessage' })

    const connection = screen.getByRole('combobox', { name: 'Line' })
    const target = screen.getByRole('combobox', { name: 'Conversation' })
    fireEvent.change(connection, { target: { value: 'conn_support:0' } })
    fireEvent.change(target, { target: { value: 'thread_support' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect iMessage' }))

    await waitFor(() => expect(connect).toHaveBeenCalledWith({
      connectionId: 'conn_support', transport: 'imessage', targetId: 'thread_support', boxMode: 'shared',
    }))
  })

  it('distinguishes an Inkbox email identity from an iMessage identity with the same label', async () => {
    const connect = setup({
      ...singleChoice,
      connections: [{
        id: 'conn_inkbox', label: 'Owned Inkbox', providerId: 'inkbox',
        identities: [
          { kind: 'handle', transport: 'imessage', label: '@research' },
          { kind: 'email', transport: 'email', label: '@research' },
        ],
      }],
    })
    await screen.findByRole('button', { name: 'Connect iMessage' })
    expect(screen.getByText('iMessage via Owned Inkbox')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Email line' }))
    expect(screen.getByText('Email via Owned Inkbox')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect Email' }))

    await waitFor(() => expect(connect).toHaveBeenCalledWith({
      connectionId: 'conn_inkbox', transport: 'email', targetId: 'thread_research', boxMode: 'shared',
    }))
  })
})
