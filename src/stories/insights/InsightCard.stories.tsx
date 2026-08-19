import type { Meta, StoryObj } from '@storybook/react'

import { InsightCard } from '../../web-react'

/**
 * The single card, one story per state the honesty rules produce: a real move
 * with its baseline, a move whose arrow and sentiment disagree (tone is the
 * caller's `polarity`, not the direction), a value with nothing to compare
 * against (no fabricated delta), a figure still being computed, and a figure
 * that is not a measurement at all.
 */

const meta: Meta<typeof InsightCard> = {
  title: 'Insights/InsightCard',
  component: InsightCard,
  decorators: [
    (Story) => (
      <div className="w-[300px] p-6">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof InsightCard>

/** Rising spend — bad news on an up arrow, because the caller said so. */
export const SpendToday: Story = {
  args: {
    eyebrow: 'Spend',
    title: 'Spend today',
    value: 41.2,
    unit: 'USD',
    previous: 33.8,
    polarity: 'lower-is-better',
    series: [18, 22, 21, 26, 30, 29, 33.8, 36, 41.2],
    description: 'Sandbox minutes across all workspaces, since 00:00 UTC.',
    action: { label: 'Open spend report', onClick: () => console.log('open spend report') },
  },
}

/** Rising missions landed — the same arrow, good news. */
export const MissionsLanded: Story = {
  args: {
    eyebrow: 'Missions',
    title: 'Missions landed',
    value: 128,
    unit: 'runs',
    previous: 104,
    polarity: 'higher-is-better',
    series: [61, 74, 70, 88, 95, 104, 112, 121, 128],
    description: 'Completed runs in the last 24 hours.',
  },
}

/** Eval pass rate with a gap in the series — the line breaks, the label says so. */
export const PassRateWithGap: Story = {
  args: {
    eyebrow: 'Eval',
    title: 'Pass rate',
    value: 94.6,
    unit: '%',
    previous: 91.2,
    polarity: 'higher-is-better',
    series: [88.1, 89.4, Number.NaN, 90.2, 91.2, 93.0, 94.6],
    description: 'weightedComposite across the release suite; one lane failed to report.',
  },
}

/** A pre-formatted total carries no delta — there is nothing to subtract. */
export const NoBaseline: Story = {
  args: {
    eyebrow: 'Spend',
    title: 'Balance',
    value: '$1,204.66',
    description: 'Prepaid credits remaining. No prior reading on file.',
  },
}

/** The figure is still being computed: the word is the signal. */
export const Live: Story = {
  args: {
    eyebrow: 'Eval',
    title: 'Regression suite',
    value: 61,
    unit: '%',
    live: true,
    liveLabel: 'Updating',
    series: [55, 57, 58, 61],
  },
}

/** A producer divided by zero — the card refuses to print it as a reading. */
export const Unavailable: Story = {
  args: {
    eyebrow: 'Spend',
    title: 'Cost per run',
    value: Number.NaN,
    unit: 'USD',
    previous: 4,
    description: 'No runs in the window, so the quotient does not exist.',
  },
}

/** The four lane shapes side by side, as a dashboard row would mount them. */
export const LaneRow: Story = {
  render: () => (
    <div className="grid w-[640px] max-w-full grid-cols-2 gap-3">
      <InsightCard {...(SpendToday.args as React.ComponentProps<typeof InsightCard>)} />
      <InsightCard {...(MissionsLanded.args as React.ComponentProps<typeof InsightCard>)} />
      <InsightCard {...(PassRateWithGap.args as React.ComponentProps<typeof InsightCard>)} />
      <InsightCard {...(NoBaseline.args as React.ComponentProps<typeof InsightCard>)} />
    </div>
  ),
}
