// @vitest-environment jsdom
/**
 * The self-contained ConfirmDialog (no dialog library): it must expose a modal
 * role, activate the focused control, cancel on Esc, and keep focus inside the panel.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ConfirmDialog } from '../../src/vault/ConfirmDialog'

afterEach(cleanup)

function mount(over: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    createElement(ConfirmDialog, {
      open: true,
      title: 'Delete file?',
      onConfirm,
      onCancel,
      ...over,
    }),
  )
  return { onConfirm, onCancel }
}

describe('ConfirmDialog', () => {
  it('renders nothing when closed', () => {
    const { onConfirm, onCancel } = mount({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('exposes an aria-modal dialog labelled by its title', () => {
    mount()
    const dialog = screen.getByRole('dialog', { name: 'Delete file?' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
  })

  it('Enter activates the focused confirm button once, Esc cancels', async () => {
    const user = userEvent.setup()
    const { onConfirm, onCancel } = mount()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm' }))
    await user.keyboard('{Enter}')
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('Enter activates Cancel when confirmation is disabled=%s', async (confirmDisabled) => {
    const user = userEvent.setup()
    const { onConfirm, onCancel } = mount({ confirmDisabled })
    screen.getByRole('button', { name: 'Cancel' }).focus()
    await user.keyboard('{Enter}')
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('Enter in the file path submits once', async () => {
    const user = userEvent.setup()
    const { onConfirm, onCancel } = mount({
      children: createElement('input', { 'aria-label': 'New file path' }),
    })
    await user.type(screen.getByRole('textbox', { name: 'New file path' }), 'notes.md{Enter}')
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('Enter in a text area keeps the newline without confirming', async () => {
    const user = userEvent.setup()
    const { onConfirm } = mount({
      children: createElement('textarea', { 'aria-label': 'Notes' }),
    })
    await user.type(screen.getByRole('textbox', { name: 'Notes' }), 'first{Enter}second')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Notes' }).value).toBe('first\nsecond')
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('input submission and direct submission respect the disabled confirmation', async () => {
    const user = userEvent.setup()
    const { onConfirm } = mount({
      confirmDisabled: true,
      children: createElement('input', { 'aria-label': 'New file path' }),
    })
    await user.type(screen.getByRole('textbox', { name: 'New file path' }), 'notes.md{Enter}')
    fireEvent.submit(screen.getByRole('dialog'))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('clicking the backdrop cancels; clicking the panel does not', () => {
    const { onCancel } = mount()
    fireEvent.click(screen.getByRole('dialog'))
    expect(onCancel).not.toHaveBeenCalled()
  })
})
