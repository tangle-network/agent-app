// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { render, screen } from '@testing-library/react'

import { AgentWorkspaceLayout, type AgentWorkspaceSessionConfig } from './index'
import type { SessionSummary } from '../session-shell'

type Icon = ComponentType<{ className?: string }>
const HistoryIcon: Icon = () => null

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return { id, title: `Session ${id}`, updatedAt: '2026-08-01T10:00:00.000Z', ...over }
}

function config(over: Partial<AgentWorkspaceSessionConfig> = {}): AgentWorkspaceSessionConfig {
  return {
    icon: HistoryIcon,
    href: '/app/ws_1/history',
    hrefForSession: (id) => `/app/ws_1/chat/${id}`,
    sessions: [session('a'), session('b')],
    totalCount: 2,
    ...over,
  }
}

describe('AgentWorkspaceLayout', () => {
  it('appends the shared History row and composes the capped session list', () => {
    renderWorkspace({
      sessions: config({ sessions: [session('a'), session('b')], limit: 1, totalCount: 2 }),
    })

    expect(screen.getByRole('link', { name: 'New' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Collapse History' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'View all chats' }).getAttribute('href')).toBe('/app/ws_1/history')
    expect(screen.getByRole('link', { name: 'Session a' }).getAttribute('href')).toBe('/app/ws_1/chat/a')
  })

  it('uses shared longest-prefix active-route resolution', () => {
    renderWorkspace({
      sessions: config(),
      activeRoute: {
        pathname: '/app/ws_1/chat/new',
        base: '/app/ws_1',
        routes: [
          { id: 'chat', path: '/chat' },
          { id: 'new', path: '/chat/new' },
        ],
      },
    })

    expect(screen.getByRole('link', { name: 'New' }).className).toContain('bg-[var(--accent-surface-strong)]')
  })

  it('adds the shared History route to active navigation automatically', () => {
    renderWorkspace({
      sessions: config(),
      activeRoute: {
        pathname: '/app/ws_1/history',
        base: '/app/ws_1',
        routes: [{ id: 'new', path: '/chat/new' }],
      },
    })

    expect(screen.getByText('History').parentElement?.parentElement?.className).toContain('bg-[var(--accent-surface-strong)]')
  })

  it('does not invent a History route when the product gives an unrelated URL', () => {
    renderWorkspace({
      sessions: config({ href: '/history' }),
      activeRoute: {
        pathname: '/app/ws_1/history',
        base: '/app/ws_1',
        routes: [{ id: 'new', path: '/chat/new' }],
      },
    })

    expect(screen.getByText('History').parentElement?.parentElement?.className).not.toContain('bg-[var(--accent-surface-strong)]')
  })
})

function renderWorkspace(over: Partial<Parameters<typeof AgentWorkspaceLayout>[0]> = {}) {
  return render(
    <AgentWorkspaceLayout
      navItems={[{ id: 'new', label: 'New', icon: HistoryIcon, href: '/app/ws_1/chat/new' }]}
      sessions={config()}
      {...over}
    >
      <div>content</div>
    </AgentWorkspaceLayout>,
  )
}
