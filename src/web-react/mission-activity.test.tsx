// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { AgentActivityPanel, type AgentActivityPage, type AgentActivityRecord } from './mission-activity'

function record(id: string, overrides: Partial<AgentActivityRecord> = {}): AgentActivityRecord {
  return {
    taskId: id,
    tool: 'coder',
    status: 'completed',
    detail: 'fix the thing',
    startedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('AgentActivityPanel', () => {
  it('renders rows on a successful load, never the empty label', async () => {
    const fetchActivity = vi.fn(
      async (): Promise<AgentActivityPage> => ({
        items: [record('t1', { detail: 'fix the thing' }), record('t2', { detail: 'ship the other thing' })],
      }),
    )
    render(<AgentActivityPanel fetchActivity={fetchActivity} />)

    await waitFor(() => expect(screen.getByText(/fix the thing/)).toBeTruthy())
    expect(screen.getByText(/ship the other thing/)).toBeTruthy()
    expect(screen.queryByText('No agent runs yet.')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders the empty label only once the load actually succeeds empty', async () => {
    const fetchActivity = vi.fn(async (): Promise<AgentActivityPage> => ({ items: [] }))
    render(<AgentActivityPanel fetchActivity={fetchActivity} />)

    await waitFor(() => expect(screen.getByText('No agent runs yet.')).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('never shows the empty label while the load is in flight', () => {
    const fetchActivity = vi.fn(() => new Promise<AgentActivityPage>(() => {}))
    render(<AgentActivityPanel fetchActivity={fetchActivity} />)

    // First paint, before the effect's fetch resolves: `rows` is `[]` exactly
    // like the true-empty case, and only the status discriminant tells them
    // apart — this is the collapse the status field exists to prevent.
    expect(screen.queryByText('No agent runs yet.')).toBeNull()
    expect(screen.getByRole('status', { name: '' }).textContent).toBe('Loading activity…')
  })

  it('renders the error, never the empty label, and never clears rows already on screen', async () => {
    let attempt = 0
    const fetchActivity = vi.fn(async (): Promise<AgentActivityPage> => {
      attempt += 1
      if (attempt === 1) return { items: [record('t1')] }
      throw new Error('activity feed unavailable')
    })
    render(<AgentActivityPanel fetchActivity={fetchActivity} />)
    await waitFor(() => expect(screen.getByText(/fix the thing/)).toBeTruthy())

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('activity feed unavailable'))

    expect(screen.queryByText('No agent runs yet.')).toBeNull()
    // The row from the successful first load stays visible under the error.
    expect(screen.getByText(/fix the thing/)).toBeTruthy()
  })

  it('pages older runs onto the held rows via the cursor, deduping by taskId', async () => {
    const fetchActivity = vi.fn(async (cursor?: string): Promise<AgentActivityPage> => {
      if (cursor === undefined) return { items: [record('t1', { startedAt: '2026-08-02T00:00:00.000Z' })], nextCursor: 'page-2' }
      return { items: [record('t2', { startedAt: '2026-08-01T00:00:00.000Z' })] }
    })
    render(<AgentActivityPanel fetchActivity={fetchActivity} />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Older runs' })).toBeTruthy())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Older runs' }))
    })

    await waitFor(() => expect(fetchActivity).toHaveBeenCalledWith('page-2'))
    expect(screen.queryByRole('button', { name: 'Older runs' })).toBeNull()
    expect(fetchActivity).toHaveBeenCalledTimes(2)
  })
})
