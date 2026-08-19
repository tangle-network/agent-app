import type { Meta, StoryObj } from '@storybook/react'
import { ComposerHero } from '../../studio-react'

/**
 * The hero is mounted WITHOUT a workspaceId on purpose: that skips the
 * `/api/media-models` fetch, leaving the model select disabled with its
 * "No models are available" hint, and keeps Generate disabled — the honest
 * shell state for docs. (With a workspaceId it would fetch and, against the
 * Storybook dev server, land in the model-load error state instead.)
 */
const meta: Meta<typeof ComposerHero> = {
  title: 'Studio/ComposerHero',
  component: ComposerHero,
  decorators: [
    (Story) => (
      <div className="w-[640px] p-4">
        <Story />
      </div>
    ),
  ],
  args: {
    onGenerated: (generation) => console.log('onGenerated', generation.id),
  },
}

export default meta
type Story = StoryObj<typeof ComposerHero>

/** Left-aligned rail treatment (the default inside StudioWorkspace). */
export const Default: Story = {}

/** Focus-mode heading treatment. */
export const CenterAligned: Story = {
  name: 'Center aligned',
  args: { align: 'center' },
}

/** Passing a workspaceId makes the model fetch fail against the dev server —
 *  useful to review the destructive hint under the disabled model select. */
export const ModelLoadError: Story = {
  name: 'Model load error',
  args: { workspaceId: 'ws-demo' },
}
