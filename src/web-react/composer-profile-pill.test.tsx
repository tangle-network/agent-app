// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposerProfilePill } from './composer-profile-pill'

const profiles = [
  { id: 'research', name: 'Research', description: 'Finds and cites sources' },
  { id: 'writer', name: 'Writer', description: 'Drafts posts' },
]

afterEach(cleanup)

describe('ComposerProfilePill', () => {
  it('shows the selected profile and changes it from the menu', () => {
    const onChange = vi.fn()
    render(<ComposerProfilePill selection={{ value: 'research', onChange, profiles }} />)
    const trigger = screen.getByRole('button', { name: /agent profile/i })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByText('Writer'))
    expect(onChange).toHaveBeenCalledWith('writer')
  })

  it('caps its width in the composer and spans a menu row', () => {
    const selection = { value: 'research', onChange: () => {}, profiles }
    const { rerender } = render(<ComposerProfilePill selection={selection} />)
    expect(screen.getByRole('button', { name: /agent profile/i }).className).toContain('max-w-[180px]')
    rerender(<ComposerProfilePill selection={selection} placement="menu-row" />)
    const row = screen.getByRole('button', { name: /agent profile/i })
    expect(row.className).toContain('h-9')
    expect(row.className).toContain('w-full')
    // The picker root shrink-wraps; the row must widen it too.
    expect((row.parentElement as HTMLElement).className).toContain('w-full')
    rerender(<ComposerProfilePill selection={selection} placement="mode-strip" />)
    const quiet = screen.getByRole('button', { name: /agent profile/i })
    expect(quiet.className).toContain('bg-transparent')
    expect(quiet.className).toContain('focus-visible:ring-inset')
  })

  it('keeps the menu-row look on the locked trigger that offers a new chat', () => {
    const onNewChat = vi.fn()
    render(
      <ComposerProfilePill
        selection={{ value: 'research', onChange: () => {}, profiles }}
        locked
        onNewChat={onNewChat}
        placement="menu-row"
      />,
    )
    const trigger = screen.getByRole('button', { name: 'Agent profile (locked)' })
    expect(trigger.className).toContain('h-9')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByText('New chat to switch profile'))
    expect(onNewChat).toHaveBeenCalledOnce()
  })

  it('offers no change once the thread is locked', () => {
    const onChange = vi.fn()
    render(<ComposerProfilePill selection={{ value: 'research', onChange, profiles }} locked />)
    fireEvent.click(screen.getByRole('button', { name: /agent profile/i }))
    expect((screen.getByRole('button', { name: /agent profile/i }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('Writer')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
})
