import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import { ChatComposer, type SlashCommand } from '../../web-react'
import { withPopoverHeadroom } from './fixtures'

/**
 * The composer's `/` commands. The menu opens only while the whole draft is
 * one leading slash token, so the deterministic states below just seed
 * `initialValue`: `/` shows every command, `/mo` shows the ranking filtered,
 * and the interactive story runs picks into a readout (the GIF is recorded
 * from that one). The menu anchors to the textarea and opens UPWARD through
 * PopoverSurface — hence `withPopoverHeadroom`, same as the picker stories.
 */

function demoCommands(onRun: (name: string) => void): SlashCommand[] {
  return [
    { name: 'clear', description: 'Clear the conversation', run: () => onRun('clear') },
    { name: 'compact', description: 'Summarize and compact the context', run: () => onRun('compact') },
    { name: 'model', description: 'Switch the model for this session', run: () => onRun('model') },
    { name: 'rename', description: 'Rename this session', run: () => onRun('rename') },
  ]
}

const meta: Meta<typeof ChatComposer> = {
  title: 'ChatControls/ChatComposerSlash',
  component: ChatComposer,
  decorators: [
    withPopoverHeadroom,
    (Story) => (
      <div className="w-[576px] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof ChatComposer>

/** Interactive: type `/`, filter, arrow, Enter — the pick clears the token
 *  and echoes into the readout below. */
export const Interactive: Story = {
  render: () => {
    const [last, setLast] = useState<string | null>(null)
    return (
      <div className="space-y-3">
        <ChatComposer
          onSend={(message) => console.log('send', message)}
          placeholder="Message the agent — or type / for commands…"
          slashCommands={demoCommands((name) => setLast(`/${name}`))}
        />
        <p className="px-1 text-sm text-muted-foreground" data-testid="last-command">
          {last ? `Ran: ${last}` : 'No command run yet — type / to see them.'}
        </p>
      </div>
    )
  },
}

/** The open menu: draft is exactly `/`, so every command lists. */
export const OpenMenu: Story = {
  name: 'Open (draft is "/")',
  render: () => (
    <ChatComposer
      onSend={() => {}}
      initialValue="/"
      slashCommands={demoCommands(() => {})}
      placeholder="Message the agent…"
    />
  ),
}

/** Filtered: `/mo` leaves the one prefix hit. */
export const Filtered: Story = {
  render: () => (
    <ChatComposer
      onSend={() => {}}
      initialValue="/mo"
      slashCommands={demoCommands(() => {})}
      placeholder="Message the agent…"
    />
  ),
}

/** No match: the empty state, and Enter would send the raw text. */
export const NoMatch: Story = {
  name: 'No match',
  render: () => (
    <ChatComposer
      onSend={() => {}}
      initialValue="/zzz"
      slashCommands={demoCommands(() => {})}
      placeholder="Message the agent…"
    />
  ),
}
