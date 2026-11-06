// @vitest-environment jsdom
/**
 * The save bar's `invalid` state: values that only make sense together can be
 * edited into a shape the product cannot save yet. The bar says why, in place
 * of the count, keeps Discard and refuses Save until the edits are valid.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SettingsSaveBar } from '../../src/settings-react'

const WHY = 'Per day cannot exceed the total cap'

describe('SettingsSaveBar invalid edits', () => {
  it('replaces the count with why the edits are not valid yet and disables Save', () => {
    const { container } = render(
      <SettingsSaveBar changes={2} state="idle" invalid={WHY} onDiscard={() => undefined} onSave={vi.fn()} />,
    )
    expect(screen.getByText(WHY)).toBeTruthy()
    expect(screen.queryByText('2 unsaved changes')).toBeNull()
    expect((screen.getByRole('button', { name: 'Discard' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true)
    expect(container.querySelector('[data-settings-save-bar]')?.hasAttribute('data-sticky')).toBe(true)
  })

  it('shows the count and enables Save once the edits are valid', () => {
    render(<SettingsSaveBar changes={1} state="idle" onDiscard={() => undefined} onSave={vi.fn()} />)
    expect(screen.getByText('1 unsaved change')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps the at-rest line when invalid edits have nothing to save', () => {
    render(<SettingsSaveBar changes={0} state="idle" invalid={WHY} onDiscard={() => undefined} onSave={vi.fn()} />)
    expect(screen.getByText('No unsaved changes')).toBeTruthy()
    expect(screen.queryByText(WHY)).toBeNull()
  })
})
