// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatMessages, TurnProgress } from './index'

describe('TurnProgress', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows the in-flight text until the server names a stage, then the stage', () => {
    const { rerender } = render(<TurnProgress phase={null} />)
    expect(screen.getByRole('status').textContent).toBe('Sending…')
    rerender(<TurnProgress phase={{ message: 'Preparing your workspace…' }} />)
    expect(screen.getByRole('status').textContent).toBe('Preparing your workspace…')
  })

  it('adds the seconds since the turn was sent once the wait is noticeable', () => {
    const startedAt = Date.now()
    render(<TurnProgress phase={{ message: 'Thinking…' }} startedAt={startedAt} />)
    expect(screen.getByRole('status').textContent).toBe('Thinking…')
    act(() => { vi.advanceTimersByTime(4000) })
    expect(screen.getByRole('status').textContent).toBe('Thinking…4s')
  })

  it('replaces the thinking row of a pending turn in ChatMessages', () => {
    render(
      <ChatMessages
        messages={[{ id: 'u1', role: 'user', content: 'Draft a launch post.' }]}
        loading
        turnPhase={{ message: 'Starting the agent session…' }}
      />,
    )
    expect(screen.getByRole('status').textContent).toBe('Starting the agent session…')
  })
})
