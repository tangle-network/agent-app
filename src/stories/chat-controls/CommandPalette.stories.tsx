import type { Meta, StoryObj } from '@storybook/react'
import { useEffect, useState, type ReactNode } from 'react'

import { CommandPalette, type CommandPaletteItem } from '../../web-react'
import { buildCommandPaletteItems } from '../../session-shell/index'

/**
 * The Cmd/Ctrl+K surface. `Open` is the interactive story: the hotkey toggles
 * the palette, the readout under the button echoes the last selection. The
 * rest pin one state each — filtered, keyboard-moved, empty, loading — so the
 * states are reviewable without driving the keyboard by hand.
 */

const items: CommandPaletteItem[] = buildCommandPaletteItems({
  sessions: [
    { id: 's7', title: 'Pricing page rewrite', updatedAt: '2026-08-17T14:22:00.000Z' },
    { id: 's6', title: 'Q3 launch checklist', updatedAt: '2026-08-16T09:05:00.000Z' },
    { id: 's5', title: null, updatedAt: '2026-08-15T18:41:00.000Z' },
    { id: 's4', title: 'Onboarding email audit', updatedAt: '2026-08-12T11:30:00.000Z' },
    { id: 's3', title: 'Changelog draft', updatedAt: '2026-08-09T16:02:00.000Z' },
  ],
  actions: [
    { id: 'new-chat', label: 'New chat', hint: '⌘N', keywords: ['create', 'start'] },
    { id: 'settings', label: 'Open settings', hint: '⌘,', keywords: ['preferences', 'config'] },
    { id: 'toggle-theme', label: 'Toggle theme', description: 'Switch dark and light', keywords: ['dark', 'light'] },
    { id: 'history', label: 'View all sessions', description: 'Search the full history' },
  ],
})

/** Dispatch keys at the palette input after mount — the deterministic way to
 *  pin "keyboard navigated to the third row" without a play function. */
function AutoKeys({ keys, children }: { keys: string[]; children: ReactNode }) {
  useEffect(() => {
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]')
    if (!input) return
    for (const key of keys) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    }
  }, [keys])
  return <>{children}</>
}

const meta: Meta<typeof CommandPalette> = {
  title: 'ChatControls/CommandPalette',
  component: CommandPalette,
}

export default meta
type Story = StoryObj<typeof CommandPalette>

/** Interactive: a host page with its own button; the palette toggles on
 *  Cmd/Ctrl+K and selections echo into the page. This is the story the demo
 *  GIF is recorded from. */
export const Open: Story = {
  render: () => {
    const [open, setOpen] = useState(false)
    const [last, setLast] = useState<string | null>(null)
    return (
      <div className="w-[420px] space-y-3 p-4">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent"
        >
          Open palette
          <kbd className="rounded border border-border bg-background px-1 py-0.5 text-xs">⌘K</kbd>
        </button>
        <p className="text-sm text-muted-foreground" data-testid="last-selection">
          {last ? `Last selection: ${last}` : 'Nothing selected yet — press Cmd/Ctrl+K.'}
        </p>
        <CommandPalette
          items={items}
          open={open}
          onOpenChange={setOpen}
          onSelect={(item) => setLast(item.label)}
        />
      </div>
    )
  },
}

/** Held open, unfiltered: recent-first sessions, then actions with hints. */
export const OpenState: Story = {
  name: 'Open (pinned state)',
  render: () => (
    <CommandPalette items={items} open onOpenChange={() => {}} onSelect={() => {}} />
  ),
}

/** Filtered: the ranking ladder visible — prefix and word-prefix hits first. */
export const Filtered: Story = {
  render: () => (
    <CommandPalette items={items} open onOpenChange={() => {}} onSelect={() => {}} initialQuery="chat" />
  ),
}

/** Keyboard navigation: two ArrowDowns on mount, so the active row sits on
 *  the third item and `aria-activedescendant` is reviewable as a state. */
export const KeyboardNav: Story = {
  name: 'Keyboard nav',
  render: () => (
    <AutoKeys keys={['ArrowDown', 'ArrowDown']}>
      <CommandPalette items={items} open onOpenChange={() => {}} onSelect={() => {}} />
    </AutoKeys>
  ),
}

/** Empty: the query names itself in the empty state. */
export const Empty: Story = {
  render: () => (
    <CommandPalette items={items} open onOpenChange={() => {}} onSelect={() => {}} initialQuery="zzz-no-match" />
  ),
}

/** Loading: the input stays live while the source resolves; no premature
 *  empty state. */
export const Loading: Story = {
  render: () => (
    <CommandPalette items={[]} open onOpenChange={() => {}} onSelect={() => {}} loading />
  ),
}
