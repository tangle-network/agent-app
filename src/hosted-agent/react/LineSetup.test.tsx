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
