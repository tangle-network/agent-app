// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Generation } from '../studio'
import { MenuPill } from './composer-option-controls'
import { VaultPathPopover, type VaultPathPopoverProps } from './vault-path-popover'

function generation(id: string, type: string): Generation {
  return { id, type, prompt: 'prompt', result: null, model: null, cost: null, createdAt: null, metadata: null }
}

function PopoverHarness(props: Omit<VaultPathPopoverProps, 'triggerRef' | 'panelRef'>) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  return (
    <>
      <button ref={triggerRef} type="button">Vault path</button>
      <VaultPathPopover {...props} triggerRef={triggerRef} panelRef={panelRef} />
    </>
  )
}

describe('VaultPathPopover', () => {
  it('prefills the single-type and mixed defaults', () => {
    const common = { open: true, onSubmit: () => {}, onCancel: () => {} }
    const view = render(<PopoverHarness {...common} generations={[generation('1', 'image')]} />)
    expect((screen.getByLabelText('Save 1 item to') as HTMLInputElement).value).toBe('generated/images')
    view.rerender(<PopoverHarness {...common} generations={[generation('1', 'image'), generation('2', 'video')]} />)
    expect((screen.getByLabelText('Save 2 items to') as HTMLInputElement).value).toBe('generated/media')
  })

  it('normalizes a typed path before Save submits it', () => {
    const onSubmit = vi.fn()
    render(<PopoverHarness open generations={[generation('1', 'image')]} onSubmit={onSubmit} onCancel={() => {}} />)
    fireEvent.change(screen.getByLabelText('Save 1 item to'), { target: { value: ' /a/b/ ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).toHaveBeenCalledWith('a/b')
  })

  it('rejects traversal and does not submit it', () => {
    const onSubmit = vi.fn()
    render(<PopoverHarness open generations={[generation('1', 'image')]} onSubmit={onSubmit} onCancel={() => {}} />)
    fireEvent.change(screen.getByLabelText('Save 1 item to'), { target: { value: '..' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('Enter a folder path inside the vault.')).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('shows an inline error and allows retry when saving rejects', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('offline'))
    render(<PopoverHarness open generations={[generation('1', 'image')]} onSubmit={onSubmit} onCancel={() => {}} />)
    const input = screen.getByLabelText('Save 1 item to') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'projects/art' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Could not save to vault. Try again.')).toBeTruthy()
    expect(screen.getByText('Save 1 item to')).toBeTruthy()
    expect(input.value).toBe('projects/art')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
  })

  it('submits with Enter and cancels from the button', () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    render(<PopoverHarness open generations={[generation('1', 'image')]} onSubmit={onSubmit} onCancel={onCancel} />)
    const input = screen.getByLabelText('Save 1 item to')
    fireEvent.change(input, { target: { value: 'projects/art' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    fireEvent.submit(input.closest('form')!)
    expect(onSubmit).toHaveBeenCalledWith('projects/art')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})

describe('MenuPill', () => {
  it('updates the selected label in place and closes after selection', () => {
    const onSelect = vi.fn()
    const choices = [
      { value: 'draft', label: 'Draft' },
      { value: 'final', label: 'Final' },
    ] as const
    function Harness() {
      const [value, setValue] = useState<'draft' | 'final'>('draft')
      return (
        <MenuPill
          label="Quality"
          value={value}
          choices={choices}
          onSelect={(next) => { onSelect(next); setValue(next) }}
        />
      )
    }

    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Quality' })
    expect(trigger.textContent).toContain('Draft')
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu')
    const rows = within(menu).getAllByRole('menuitemradio')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Final' }))
    expect(onSelect).toHaveBeenCalledWith('final')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: 'Quality' })).toBe(trigger)
    expect(trigger.textContent).toContain('Final')
  })
})
