// @vitest-environment jsdom
/**
 * TEMPORARY smoke harness for the assistant stories — mounts every exported
 * story exactly as written (args through the meta component, render functions
 * called with their args, meta + story decorators applied) and asserts the
 * tree mounts with its key marker. Exists because the storybook setup is not
 * currently restorable in this checkout; delete once the dev-server smoke
 * (iframe.html 200s) covers the same ground.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

type AnyMeta = {
  component?: unknown
  decorators?: unknown[]
}
type AnyStory = {
  args?: Record<string, unknown>
  render?: (args: Record<string, unknown>) => ReactNode
  decorators?: unknown[]
}

/** Hand-rolled compose: story decorators wrap the component, meta decorators
 *  wrap those (storybook's order). Enough for these stories, which carry at
 *  most one decorator per level. */
function mountStory(meta: AnyMeta, story: AnyStory): ReactElement {
  const args = story.args ?? {}
  const Component = meta.component as (
    props: Record<string, unknown>,
  ) => ReactElement
  let node: ReactNode = story.render ? (
    story.render(args)
  ) : (
    <Component {...args} />
  )
  for (const d of [...(story.decorators ?? []), ...(meta.decorators ?? [])]) {
    const dec = d as (
      Story: () => ReactNode,
      ctx: { args: Record<string, unknown> },
    ) => ReactNode
    const inner = node
    node = dec(() => inner, { args })
  }
  return <>{node}</>
}

async function mount(meta: unknown, story: unknown) {
  const utils = render(
    mountStory(meta as AnyMeta, story as AnyStory),
  )
  // Flush the stub client's model/thread fetches so their state commits land
  // inside act rather than warning after the test.
  await act(async () => {})
  return utils
}

import * as historyModule from './AssistantHistory.stories'
import * as dockModule from './AssistantDock.stories'
import * as panelModule from './AssistantPanel.stories'
import * as transcriptModule from './AssistantTranscript.stories'
import * as fullModule from './FullAssistant.stories'
import * as proposalModule from './ProposalCard.stories'
import * as resizeModule from './ResizeHandle.stories'

function storiesOf(mod: Record<string, unknown>): Array<[string, AnyStory]> {
  return Object.entries(mod).filter(
    ([name, value]) =>
      name !== 'default' && value != null && typeof value === 'object',
  ) as Array<[string, AnyStory]>
}

describe('assistant stories smoke', () => {
  for (const [name, story] of storiesOf(panelModule)) {
    it(`Panel/${name} mounts`, async () => {
      const { container } = await mount(panelModule.default, story)
      expect(container.firstChild).toBeTruthy()
    })
  }

  for (const [name, story] of storiesOf(transcriptModule)) {
    it(`Transcript/${name} mounts`, async () => {
      const { container } = await mount(transcriptModule.default, story,
      )
      expect(container.firstChild).toBeTruthy()
    })
  }

  for (const [name, story] of storiesOf(proposalModule)) {
    it(`ProposalCard/${name} mounts`, async () => {
      const { container } = await mount(proposalModule.default, story,
      )
      expect(container.firstChild).toBeTruthy()
    })
  }

  for (const [name, story] of storiesOf(historyModule)) {
    it(`History/${name} mounts`, async () => {
      const { container } = await mount(historyModule.default, story,
      )
      expect(container.firstChild).toBeTruthy()
    })
  }

  for (const [name, story] of storiesOf(resizeModule)) {
    it(`ResizeHandle/${name} mounts`, async () => {
      const { container } = await mount(resizeModule.default, story,
      )
      expect(container.firstChild).toBeTruthy()
    })
  }

  for (const [name, story] of storiesOf(dockModule)) {
    it(`Dock/${name} mounts`, async () => {
      const { container } = await mount(dockModule.default, story)
      expect(container.firstChild).toBeTruthy()
    })
  }

  for (const [name, story] of storiesOf(fullModule)) {
    it(`FullAssistant/${name} mounts`, async () => {
      const { container } = await mount(fullModule.default, story)
      expect(container.firstChild).toBeTruthy()
    })
  }

  it('Panel Empty shows the branded zero-state', async () => {
    await mount(panelModule.default, panelModule.PanelEmpty)
    expect(
      screen.getByText(/Ask the assistant to do something/i),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /^Create a workflow/ }),
    ).toBeTruthy()
  })

  it('Panel With Proposal renders the confirm card', async () => {
    await mount(panelModule.default, panelModule.PanelWithProposal)
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy()
    expect(screen.getByText('Create workflow')).toBeTruthy()
  })

  it('Panel Streaming shows the working cue', async () => {
    const { container } = await mount(panelModule.default, panelModule.PanelStreaming,
    )
    expect(
      container.querySelector('[aria-label="Assistant is working"]'),
    ).not.toBeNull()
  })

  it('Dock Collapsed shows only the launcher button', async () => {
    await mount(dockModule.default, dockModule.DockCollapsed)
    expect(screen.getByRole('button', { name: 'Open assistant' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Dock Expanded opens the drawer', async () => {
    await mount(dockModule.default, dockModule.DockExpanded)
    expect(screen.getByRole('dialog', { name: 'Assistant' })).toBeTruthy()
  })

  it('Dock With Seed prefills the composer', async () => {
    await mount(dockModule.default, dockModule.DockWithSeed)
    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement
    expect(input.value).toContain('posts the launch poster')
  })

  it('FullAssistant (open) shows the drawer over the app shell', async () => {
    await mount(fullModule.default, fullModule.FullAssistantOpen)
    expect(screen.getByRole('dialog', { name: 'Assistant' })).toBeTruthy()
    expect(screen.getByText('Your workflows')).toBeTruthy()
  })

  it('Dock Expanded streams the scripted turn and confirms the proposal', async () => {
    await mount(dockModule.default, dockModule.DockExpanded)
    const input = screen.getByLabelText('Message input')
    fireEvent.change(input, { target: { value: 'Create the Monday poster workflow' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // The scripted turn streams reasoning → tool chip → answer → proposal card.
    const confirm = await screen.findByRole(
      'button',
      { name: 'Confirm' },
      { timeout: 5000 },
    )
    expect(screen.getByText('Create workflow')).toBeTruthy()

    fireEvent.click(confirm)
    // The stub confirm resolves with the created workflow's name → status line.
    await screen.findByText(
      'Created workflow "launch-poster-monday".',
      undefined,
      { timeout: 5000 },
    )
  }, 10_000)
})
