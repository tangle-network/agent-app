// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { HostEditorPreview } from './ComposerProfilePill.stories'

afterEach(cleanup)

describe('ComposerProfilePill host editor preview', () => {
  it('preserves pending edits until cancellation before reopening the host editor', () => {
    render(<HostEditorPreview />)
    const trigger = screen.getByRole('button', { name: 'Agent profile' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const json = screen.getByLabelText('Full profile JSON')
    fireEvent.change(json, { target: { value: '{"name":"Unapplied draft"}' } })
    expect((screen.getByRole('button', { name: 'Save profile' }) as HTMLButtonElement).disabled).toBe(true)
    expect((trigger as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(trigger)
    expect(screen.queryByTestId('agent-profile-popover')).toBeNull()
    expect((json as HTMLTextAreaElement).value).toContain('Unapplied draft')
    expect((screen.getByRole('button', { name: 'Save profile' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect((trigger as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'New agent…' }))
    expect((screen.getByLabelText('Full profile JSON') as HTMLTextAreaElement).value).not.toContain('Unapplied draft')
    expect((screen.getByRole('button', { name: 'Save profile' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
