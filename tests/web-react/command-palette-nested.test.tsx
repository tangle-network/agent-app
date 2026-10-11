// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NestedNavigationExample } from '../../src/stories/chat-controls/CommandPalette.stories'

// Exercise the published SidebarLayout/ProfileAvatar, including their real
// Radix lifecycle. jsdom does not model breakpoints; explicitly open the drawer
// for the nested case and use the first account trigger for the desktop case.
describe('CommandPalette launched from shared navigation', () => {
  it.each([false, true])('owns focus and Escape above the account menu (drawer=%s)', async (drawerOpen) => {
    const user = userEvent.setup()
    render(<NestedNavigationExample />)
    const opener = screen.getByRole('button', { name: 'Open navigation' })
    if (drawerOpen) await user.click(opener)
    const drawer = drawerOpen ? screen.getByRole('dialog', { name: 'Navigation' }) : null
    const account = drawer
      ? within(drawer).getByRole('button', { name: 'User menu' })
      : screen.getAllByRole('button', { name: 'User menu' })[0]!
    // Repeat a complete transition to catch stale close/restore state.
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await user.click(account)
      await user.click(screen.getByRole('menuitem', { name: 'Search' }))
      const input = screen.getByRole('combobox', { name: 'Command palette' })
      expect(screen.queryByRole('menu')).toBeNull()
      await waitFor(() => expect(document.activeElement).toBe(input))
      await user.tab()
      expect(document.activeElement).toBe(input)
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
      await waitFor(() => expect(document.activeElement).toBe(account))
      if (drawer) expect(screen.getByRole('dialog', { name: 'Navigation' })).toBe(drawer)
    }
    if (drawer) {
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull()
      await waitFor(() => expect(document.activeElement).toBe(opener))
    }
    await waitFor(() => expect(document.body.style.pointerEvents).toBe(''))
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false)
  })
})
