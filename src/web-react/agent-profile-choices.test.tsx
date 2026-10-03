// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AgentProfileChoices } from './agent-profile-choices'

const profiles = [{ id: 'general', name: 'General', description: 'General work' }, { id: 'review', name: 'Reviewer', description: 'Review the work' }]

describe('inline profile choices', () => {
  it('uses the host catalog and changes only after explicit selection', () => {
    const onChange = vi.fn()
    render(<AgentProfileChoices profiles={profiles} value="general" onChange={onChange} />)
    expect((screen.getByRole('radio', { name: /General/ }) as HTMLInputElement).checked).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: /Reviewer/ }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('review')
  })
  it('a missing selected ID never chooses another profile', () => {
    const onChange = vi.fn()
    render(<AgentProfileChoices profiles={profiles} value="missing" onChange={onChange} />)
    expect(screen.getAllByRole('radio').every((radio) => !(radio as HTMLInputElement).checked)).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
  })
  it('shows pinned identity and only offers the host new-chat action', () => {
    const onChange = vi.fn()
    const onNewChat = vi.fn()
    render(<AgentProfileChoices profiles={profiles} value="review" onChange={onChange} locked lockReason="Profile is fixed for this conversation" onNewChat={onNewChat} />)
    expect(screen.getByText('Reviewer')).toBeTruthy()
    expect(screen.getByText('Profile is fixed for this conversation')).toBeTruthy()
    expect(screen.queryByRole('radio')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New chat to switch profile' }))
    expect(onNewChat).toHaveBeenCalledOnce()
    expect(onChange).not.toHaveBeenCalled()
  })
  it('disabled choices and locked controls do not grant an action', () => {
    const onChange = vi.fn()
    const { rerender } = render(<AgentProfileChoices profiles={profiles} value="general" onChange={onChange} disabled />)
    expect(screen.getAllByRole('radio').every((radio) => (radio as HTMLInputElement).disabled)).toBe(true)
    rerender(<AgentProfileChoices profiles={profiles} value="general" onChange={onChange} disabled locked onNewChat={vi.fn()} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
  it('separate mounted settings do not share a native radio group', () => {
    render(<><AgentProfileChoices profiles={profiles} value="general" onChange={vi.fn()} /><AgentProfileChoices profiles={profiles} value="review" onChange={vi.fn()} /></>)
    const groups = screen.getAllByRole('group', { name: 'Agent profile' })
    const names = groups.map((group) => group.querySelector('input')?.name)
    expect(new Set(names).size).toBe(2)
  })
  it('renders an explicit empty state without inventing a profile', () => {
    render(<AgentProfileChoices profiles={[]} value="" onChange={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toBe('No profiles available.')
  })
})
