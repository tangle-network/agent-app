// @vitest-environment jsdom
/**
 * The AgentActivityPanel drill-in: opening a row no longer dead-ends at a bare
 * trace id. It renders the run's waterfall (when timed) and a copy-to-clipboard
 * affordance for the trace id.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { AgentActivityPanel, type AgentActivityPage } from '../../src/web-react/mission-activity'

afterEach(cleanup)

const PAGE: AgentActivityPage = {
  items: [
    {
      taskId: 'task-1',
      tool: 'coder',
      status: 'completed',
      detail: 'implement the fix',
      startedAt: new Date('2026-06-12T10:00:00.000Z').toISOString(),
      durationMs: 30_000,
      costUsd: 0.25,
      traceId: 'a'.repeat(32),
    },
  ],
}

describe('AgentActivityPanel drill-in', () => {
  it('renders a copyable trace id (not a dead-end string) and a waterfall', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    render(createElement(AgentActivityPanel, { fetchActivity: () => Promise.resolve(PAGE) }))
    // wait for the async load, then open the row (the row is a toggle button)
    const toggle = await screen.findByText((_t, el) => el?.textContent?.includes('implement the fix') ?? false, {
      selector: 'button',
    })
    fireEvent.click(toggle)

    const copy = screen.getByRole('button', { name: 'Copy trace id' })
    expect(copy.textContent).toContain('a'.repeat(32))
    await act(async () => {
      fireEvent.click(copy)
    })
    expect(writeText).toHaveBeenCalledWith('a'.repeat(32))
    await waitFor(() => expect(screen.getByText('copied')).toBeTruthy())
  })

  it('shows the duration bar for a timed run', async () => {
    render(createElement(AgentActivityPanel, { fetchActivity: () => Promise.resolve(PAGE) }))
    const toggle = await screen.findByText((_t, el) => el?.textContent?.includes('implement the fix') ?? false, {
      selector: 'button',
    })
    fireEvent.click(toggle)
    // FlowWaterfall renders a per-row duration label ("30.0s") for the run's bar
    expect(screen.getAllByText('30.0s').length).toBeGreaterThan(0)
  })
})
