// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import {
  AgentActivityPanel,
  MissionActivityLane,
  type AgentActivityPage,
  type AgentActivityRecord,
} from './mission-activity'

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

/**
 * A delegated run appearing is work that STARTED or FINISHED — the one list
 * change worth choreographing. A run whose status merely advanced is the same
 * row it was a second ago, and re-playing its entrance is flicker, not
 * choreography, so both halves are pinned here.
 */
describe('activity rows — arrival and the live signal', () => {
  /** `--stagger-index` off every element the shipped arrival class is on. */
  function staggerIndexes(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll<HTMLElement>('.agent-arrive')).map((el) =>
      el.style.getPropertyValue('--stagger-index'))
  }

  it('lands lane rows as a sequence', () => {
    const { container } = render(
      <MissionActivityLane activity={[record('t1'), record('t2'), record('t3')]} />,
    )
    expect(staggerIndexes(container)).toEqual(['0', '1', '2'])
  })

  it('keeps an arrived lane row on the index it arrived at when a newer run lands above it', () => {
    const { container, rerender } = render(
      <MissionActivityLane activity={[record('t1'), record('t2')]} />,
    )
    expect(staggerIndexes(container)).toEqual(['0', '1'])

    rerender(<MissionActivityLane activity={[record('t0'), record('t1'), record('t2')]} />)
    // Recomputed from position this would read 0,1,2 — every settled row handed
    // a LONGER delay, which pushes a finished `.agent-arrive` back into its
    // before-phase and plays it again. Frozen at mount, only the new row is new.
    expect(staggerIndexes(container)).toEqual(['0', '0', '1'])
  })

  it('keeps a panel row on its index when a refresh inserts a newer run above it', async () => {
    let attempt = 0
    const fetchActivity = vi.fn(async (): Promise<AgentActivityPage> => {
      attempt += 1
      if (attempt === 1) return { items: [record('t1', { startedAt: '2026-08-01T00:00:00.000Z' })] }
      return {
        items: [
          record('t0', { startedAt: '2026-08-03T00:00:00.000Z', detail: 'newer run' }),
          record('t1', { startedAt: '2026-08-01T00:00:00.000Z' }),
        ],
      }
    })
    const { container } = render(<AgentActivityPanel fetchActivity={fetchActivity} />)
    await waitFor(() => expect(screen.getByText(/fix the thing/)).toBeTruthy())

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    })
    await waitFor(() => expect(screen.getByText(/newer run/)).toBeTruthy())
    // `mergeActivityPages` sorts newest-first, so t1 is now the second row —
    // the exact shape that would re-animate a panel nobody touched.
    expect(staggerIndexes(container)).toEqual(['0', '0'])
  })

  it('sweeps the label of a run still in flight, and only that one', () => {
    const { container } = render(
      <MissionActivityLane
        activity={[
          record('t1', { status: 'running', tool: 'coder' }),
          record('t2', { status: 'completed', tool: 'reviewer' }),
        ]}
      />,
    )
    const sweeping = Array.from(container.querySelectorAll<HTMLElement>('.agent-shimmer'))
    expect(sweeping.map((el) => el.textContent)).toEqual(['coder'])
    // The sweep IS the "still working" signal, so it survives the
    // reduced-motion collapse; nothing else on the row declares that.
    expect(sweeping[0]?.getAttribute('data-motion')).toBe('essential')
  })

  it('does not pulse the live dot — that animation already means "no data yet"', () => {
    const { container } = render(<MissionActivityLane activity={[record('t1', { status: 'running' })]} />)
    // INVERTED from the shipped behaviour: the live dot used to carry
    // `animate-pulse`, the same 2s fade the vault/history skeletons use, so one
    // animation meant both "work in progress" and "nothing here yet". The tone
    // stays (hue + the screen-reader word); the motion moved to the label.
    expect(container.querySelector('.animate-pulse')).toBeNull()
    expect(screen.getByText('live')).toBeTruthy()
  })
})
