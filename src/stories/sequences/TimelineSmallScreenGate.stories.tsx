import type { Meta, StoryObj } from '@storybook/react'
import { TimelineSmallScreenGate } from '../../sequences-react'

/**
 * The gate is `sm:hidden` by design — the real editor reveals it only below
 * the sm breakpoint via viewport media query. Storybook's iframe is a
 * desktop-width viewport and a decorator div cannot change that, so these
 * stories force the gate visible with a scoped `!important` override inside a
 * phone-width frame. The override is local to these stories.
 */
const meta: Meta<typeof TimelineSmallScreenGate> = {
  title: 'Sequences/TimelineSmallScreenGate',
  component: TimelineSmallScreenGate,
  decorators: [
    (Story) => (
      <div className="w-[360px] overflow-hidden rounded-xl border border-[var(--border-default)]">
        <style>{'[data-timeline-small-screen] { display: flex !important }'}</style>
        <div className="h-[560px]">
          <Story />
        </div>
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof TimelineSmallScreenGate>

/** Default copy: brand mark, "Best edited on a larger screen", guidance body. */
export const Gate: Story = {
  args: {},
}

/** Product copy override through TimelineEditorLabels. */
export const CustomCopy: Story = {
  name: 'Custom Copy',
  args: {
    labels: {
      smallScreenTitle: 'Open on desktop to cut',
      smallScreenBody: 'Scrubbing and trimming need a pointer and some elbow room. Reopen this sequence on a bigger screen.',
    },
  },
}
