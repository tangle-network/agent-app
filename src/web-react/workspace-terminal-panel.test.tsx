// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

// TerminalView pulls in xterm (needs a real canvas); it only mounts in the
// connected state, which this suite does not exercise. Stub it so the import is
// resolvable regardless.
vi.mock('@tangle-network/sandbox-ui/terminal', () => ({
  TerminalView: () => <div data-testid="terminal-view" />,
}))

const { WorkspaceTerminalPanel } = await import('./workspace-terminal-panel')
const { tabTerminalConnectionId } = await import('./sandbox-terminal')

import type { SandboxTerminalConnection } from './sandbox-terminal'

const base: SandboxTerminalConnection = {
  runtimeUrl: null,
  sidecarUrl: null,
  token: null,
  expiresAt: null,
  status: 'idle',
  error: null,
  loading: false,
}

afterEach(cleanup)

describe('tabTerminalConnectionId', () => {
  beforeEach(() => sessionStorage.clear())

  it('is stable across calls in the same tab and persists in sessionStorage', () => {
    const a = tabTerminalConnectionId()
    const b = tabTerminalConnectionId()
    expect(a).toBe(b)
    expect(sessionStorage.getItem('agent-app:terminal-connection-id')).toBe(a)
  })

  it('honors a custom storage key', () => {
    const id = tabTerminalConnectionId('custom:key')
    expect(sessionStorage.getItem('custom:key')).toBe(id)
  })
})

describe('WorkspaceTerminalPanel', () => {
  it('shows the error and a working Reconnect button', () => {
    const onRetry = vi.fn()
    const { getByText } = render(
      <WorkspaceTerminalPanel connection={{ ...base, error: 'Sandbox not available', status: 'error' }} onRetry={onRetry} />,
    )
    getByText('Sandbox not available')
    fireEvent.click(getByText('Reconnect'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('shows a provisioning message while loading', () => {
    const { getByText } = render(
      <WorkspaceTerminalPanel connection={{ ...base, loading: true, status: 'provisioning' }} />,
    )
    getByText('Provisioning sandbox…')
  })

  it('shows a Connect affordance when idle', () => {
    const onRetry = vi.fn()
    const { getByText } = render(<WorkspaceTerminalPanel connection={base} onRetry={onRetry} />)
    fireEvent.click(getByText('Connect'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('does not mount the terminal until a url + token are present', () => {
    const { queryByTestId } = render(<WorkspaceTerminalPanel connection={base} />)
    expect(queryByTestId('terminal-view')).toBeNull()
  })
})
