import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import { InsightDeck, type Insight } from '../../web-react'
import type { AsyncResourceState } from '../../web-react/async'

/**
 * The paged deck over `web-react/async`: paging arrives as a staggered
 * sequence, a reload HOLDS the cards on screen (aria-busy says the work),
 * and a failed load renders the error with retry — never the empty copy.
 */

const meta: Meta<typeof InsightDeck> = {
  title: 'Insights/InsightDeck',
  component: InsightDeck,
  decorators: [
    (Story) => (
      <div className="w-[720px] max-w-full p-6">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof InsightDeck>

function ready(value: readonly Insight[]): AsyncResourceState<readonly Insight[]> {
  return { status: 'ready', value, retry: () => console.log('retry') }
}

const INSIGHTS: Insight[] = [
  {
    id: 'spend-today',
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
  {
    id: 'missions-landed',
    eyebrow: 'Missions',
    title: 'Missions landed',
    value: 128,
    unit: 'runs',
    previous: 104,
    polarity: 'higher-is-better',
    series: [61, 74, 70, 88, 95, 104, 112, 121, 128],
    description: 'Completed runs in the last 24 hours.',
  },
  {
    id: 'pass-rate',
    eyebrow: 'Eval',
    title: 'Pass rate',
    value: 94.6,
    unit: '%',
    previous: 91.2,
    polarity: 'higher-is-better',
    series: [88.1, 89.4, Number.NaN, 90.2, 91.2, 93.0, 94.6],
    description: 'weightedComposite across the release suite; one lane failed to report.',
  },
  {
    id: 'cost-per-run',
    eyebrow: 'Spend',
    title: 'Cost per run',
    value: 0.32,
    unit: 'USD',
    previous: 0.41,
    polarity: 'lower-is-better',
    series: [0.5, 0.48, 0.44, 0.41, 0.38, 0.36, 0.32],
  },
  {
    id: 'queue-depth',
    eyebrow: 'Missions',
    title: 'Queue depth',
    value: 7,
    unit: 'waiting',
    previous: 12,
    polarity: 'lower-is-better',
    series: [15, 14, 12, 12, 10, 9, 7],
    live: true,
    liveLabel: 'Updating',
  },
  {
    id: 'regressions',
    eyebrow: 'Eval',
    title: 'New regressions',
    value: 0,
    unit: 'suites',
    previous: 2,
    polarity: 'lower-is-better',
    series: [4, 3, 3, 2, 2, 1, 0],
  },
  {
    id: 'balance',
    eyebrow: 'Spend',
    title: 'Balance',
    value: '$1,204.66',
    description: 'Prepaid credits remaining. No prior reading on file.',
  },
]

/** Seven insights paged by three — the pager, dots, counter and arrow keys. */
export const Paged: Story = {
  args: {
    state: ready(INSIGHTS),
    empty: { title: 'No insights yet', description: 'Insights appear after the first readings land.' },
    pageSize: 3,
  },
}

/** A reload holds the settled cards on screen; only aria-busy says work is happening. */
export const PollingRefresh: Story = {
  render: () => {
    function Demo() {
      const [state, setState] = useState<AsyncResourceState<readonly Insight[]>>(() => ready(INSIGHTS))
      const [tick, setTick] = useState(0)
      const reload = () => {
        // What useAsyncResource does on a poll: back through loading, holding
        // nothing, then ready with the new readings.
        setState({ status: 'loading', retry: () => console.log('retry') })
        setTimeout(() => {
          setTick((t) => t + 1)
          setState(
            ready(
              INSIGHTS.map((insight) =>
                typeof insight.value === 'number'
                  ? { ...insight, value: Math.round((insight.value + tick + 1) * 100) / 100 }
                  : insight,
              ),
            ),
          )
        }, 1200)
      }
      return (
        <div className="space-y-4">
          <div>
            <button
              type="button"
              onClick={reload}
              className="h-8 rounded-md border border-border px-3 text-xs font-medium text-foreground transition hover:bg-accent"
            >
              Simulate poll
            </button>
          </div>
          <InsightDeck
            state={state}
            empty={{ title: 'No insights yet', description: 'Insights appear after the first readings land.' }}
            pageSize={3}
          />
        </div>
      )
    }
    return <Demo />
  },
}

export const Loading: Story = {
  args: {
    state: { status: 'loading', retry: () => console.log('retry') },
    empty: { title: 'No insights yet' },
  },
}

/** A failed fetch renders the error and retry — never the empty copy. */
export const Failed: Story = {
  args: {
    state: { status: 'error', message: 'Could not load insights.', error: new Error('HTTP 503'), retry: () => console.log('retry') },
    empty: { title: 'No insights yet', description: 'Insights appear after the first readings land.' },
  },
}

export const Empty: Story = {
  args: {
    state: { status: 'empty', value: [], retry: () => console.log('retry') },
    empty: { title: 'No insights yet', description: 'Insights appear after the first readings land.' },
  },
}
