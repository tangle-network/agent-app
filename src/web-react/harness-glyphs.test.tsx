// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { HarnessLogo } from '@tangle-network/sandbox-ui/dashboard'
import type { Harness } from '../harness'
import { HarnessPicker } from './agent-session-controls'
import { HarnessGlyph } from './harness-glyphs'

it('shows the same shared artwork in the harness menu and the selected control', () => {
  const ids: Harness[] = ['claude-code', 'codex', 'factory-droids', 'pi', 'nanoclaw', 'prime']
  const selected = 'nanoclaw'
  render(<HarnessPicker value={selected} available={ids} onChange={() => {}} />)
  const trigger = screen.getByTitle('Harness')
  fireEvent.click(trigger)
  for (const id of ids) {
    const reference = render(<HarnessLogo type={id} />)
    const sharedMark = reference.container.firstElementChild!.innerHTML
    const row = screen.getAllByRole('menuitemradio').find(el => within(el).queryByRole('img', { name: id }))
    expect(row?.querySelector('[role="img"]')?.firstElementChild?.innerHTML).toBe(sharedMark)
    if (id === selected) expect(trigger.querySelector('[role="img"]')?.firstElementChild?.innerHTML).toBe(sharedMark)
    reference.unmount()
  }
})

it('retains an accessible name and fallback mark for an unknown harness', () => {
  render(<HarnessGlyph harness={'unknown-engine' as Harness} />)
  expect(screen.getByRole('img', { name: 'unknown-engine' }).querySelector('svg')).toBeTruthy()
})
