import { useEffect, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'

import { FlowWaterfall } from '../../web-react'
import { failedFlowTrace, posterFlowTrace } from './fixtures'
import { discoveryWaterfallTrace } from './discovery-waterfall-fixture'
import type { FlowTrace } from '../../trace'

/** Shared searchable trace viewer, including a timing-only recorded Discovery canary. */

const meta: Meta<typeof FlowWaterfall> = {
  title: 'ChatControls/FlowWaterfall',
  component: FlowWaterfall,
  decorators: [
    (Story) => (
      <div className="p-4" style={{ width: 'min(800px, calc(100vw - 32px))', minWidth: 0 }}>
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof FlowWaterfall>

/** Healthy trace — five spans, total + cost in the footer. */
export const Healthy: Story = {
  args: { trace: posterFlowTrace },
}

/** A failed tool span renders in the destructive tone. */
export const WithFailure: Story = {
  name: 'With failure',
  args: { trace: failedFlowTrace },
}

/** Both traces stacked for the tone comparison. */
export const AllStates: Story = {
  name: 'All states',
  render: () => (
    <div className="flex flex-col gap-6">
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Healthy</p>
        <FlowWaterfall trace={posterFlowTrace} />
      </div>
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">With failure</p>
        <FlowWaterfall trace={failedFlowTrace} />
      </div>
    </div>
  ),
}

/** Source and projection limits are in discovery-waterfall-provenance.md. */
export const RecordedDiscovery: Story = {
  args: { trace: discoveryWaterfallTrace, label: 'Discovery run trace' },
}

/** A replay of real recorded timings, compressed 20x. This is not a live research run. */
function StreamingReplay() {
  const [now, setNow] = useState(0)
  useEffect(() => {
    const start = Date.now()
    const timer = setInterval(() => setNow(Math.min(discoveryWaterfallTrace.totalMs, (Date.now() - start) * 20)), 100)
    return () => clearInterval(timer)
  }, [])
  const trace: FlowTrace = {
    ...discoveryWaterfallTrace,
    spans: discoveryWaterfallTrace.spans.filter(span => span.startMs <= now).map(span => ({
      ...span, endMs: Math.min(now, span.endMs), status: span.endMs > now ? 'running' : span.status,
    })),
    totalMs: now,
    // Final totals are unknown until settlement, rather than replayed ahead of the work.
    promptTokens: now === discoveryWaterfallTrace.totalMs ? discoveryWaterfallTrace.promptTokens : 0,
    completionTokens: now === discoveryWaterfallTrace.totalMs ? discoveryWaterfallTrace.completionTokens : 0,
    toolCalls: discoveryWaterfallTrace.spans.filter(span => ['tool', 'handoff'].includes(span.kind) && span.startMs <= now).length,
    errors: discoveryWaterfallTrace.spans.filter(span => span.status === 'failed' && span.endMs <= now).length,
  }
  return <div><p className="mb-2 text-xs text-muted-foreground">Recorded Discovery replay · 20x · final token totals arrive at settlement</p>
    <FlowWaterfall trace={trace} live={false} label="Streaming Discovery replay" /></div>
}

export const DiscoveryStreamingReplay: Story = { render: () => <StreamingReplay /> }

/** A stalled producer still has a growing running span between snapshots. */
export const GrowingLiveTrace: Story = {
  args: { trace: { spans: [{ id: 'root', kind: 'pipeline', name: 'Orchestrator', startMs: 0, endMs: 60000, status: 'running' },
    { id: 'tool', parentId: 'root', kind: 'tool', name: 'Waiting for tool result', startMs: 500, endMs: 60000, status: 'running' }],
    totalMs: 60000, promptTokens: 0, completionTokens: 0, toolCalls: 1 }, live: true },
}

export const EmptyFlowTrace: Story = { args: { trace: { spans: [], totalMs: 0, promptTokens: 0, completionTokens: 0, toolCalls: 0 } } }
