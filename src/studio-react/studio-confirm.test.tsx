// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StudioConfirmDialog } from './studio-confirm'

describe('StudioConfirmDialog', () => {
  it('renders the count, focuses Cancel, and invokes both actions', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(<StudioConfirmDialog open count={3} onCancel={onCancel} onConfirm={onConfirm} />)

    expect(screen.getByRole('alertdialog', { name: 'Delete 3 items?' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onConfirm).toHaveBeenCalledOnce()
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('cancels only when the backdrop itself receives mousedown', () => {
    const onCancel = vi.fn()
    render(<StudioConfirmDialog open count={1} onCancel={onCancel} onConfirm={() => {}} />)
    const panel = screen.getByRole('alertdialog')
    fireEvent.mouseDown(panel)
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.mouseDown(panel.parentElement!)
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('restores prior focus on close and wraps Tab from the last action', () => {
    const opener = document.createElement('button')
    opener.textContent = 'Open'
    document.body.append(opener)
    opener.focus()
    const view = render(<StudioConfirmDialog open count={2} onCancel={() => {}} onConfirm={() => {}} />)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const deleteButton = screen.getByRole('button', { name: 'Delete' })
    expect(document.activeElement).toBe(cancel)

    deleteButton.focus()
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Tab' })
    expect(document.activeElement).toBe(cancel)

    view.rerender(<StudioConfirmDialog open={false} count={2} onCancel={() => {}} onConfirm={() => {}} />)
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
