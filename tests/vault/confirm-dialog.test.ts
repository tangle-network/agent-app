// @vitest-environment jsdom
/**
 * The self-contained ConfirmDialog (no dialog library): it must expose a modal
 * role, confirm on Enter, cancel on Esc, and keep focus inside the panel.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

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

  it('Enter confirms, Esc cancels', () => {
    const { onConfirm, onCancel } = mount()
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('Enter is ignored while the confirm button is disabled', () => {
    const { onConfirm } = mount({ confirmDisabled: true })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('clicking the backdrop cancels; clicking the panel does not', () => {
    const { onCancel } = mount()
    fireEvent.click(screen.getByRole('dialog'))
    expect(onCancel).not.toHaveBeenCalled()
  })
})
