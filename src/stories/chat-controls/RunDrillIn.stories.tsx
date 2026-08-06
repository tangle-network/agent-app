import type { Meta, StoryObj } from '@storybook/react'

import { RunDrillIn } from '../../web-react'
import { completedToolRun, erroredToolRun, runningToolRun } from './fixtures'

/**
 * The readonly side panel for a retained tool run. It renders `fixed` against
 * the right edge of the canvas, so stories use the fullscreen layout and the
 * composite puts a fake transcript behind it for context. Close logs.
 */

const meta: Meta<typeof RunDrillIn> = {
  title: 'ChatControls/RunDrillIn',
  component: RunDrillIn,
  parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj<typeof RunDrillIn>

/** Complete run — three ok steps with captured output. */
export const Complete: Story = {
  args: { run: completedToolRun, onClose: () => console.log('close drill-in') },
}

/** Errored run — the failed step renders its stderr in the error tone. */
export const Errored: Story = {
  args: { run: erroredToolRun, onClose: () => console.log('close drill-in') },
}

/** Running with no steps yet — the panel's empty body copy. */
export const RunningEmpty: Story = {
  name: 'Running, no steps yet',
  args: { run: runningToolRun, onClose: () => console.log('close drill-in') },
}

/** Long output — the step detail scrolls inside its 12rem cap. */
export const LongOutput: Story = {
  name: 'Long output',
  args: {
    onClose: () => console.log('close drill-in'),
    run: {
      toolCallId: 'tc-test',
      toolName: 'sandbox_run_command',
      title: 'Run the poster render test suite',
      status: 'complete',
      steps: [
        {
          at: '2026-06-20T15:11:03Z',
          label: 'pnpm test -- --grep poster',
          status: 'ok',
          detail: Array.from(
            { length: 30 },
            (_, i) => `  ✓ poster render case ${i + 1} — contrast, bleed, and export size within tolerance (${38 + i}ms)`,
          ).join('\n'),
        },
      ],
    },
  },
}

/** In context — the panel over a dimmed transcript, as chat actually hosts it. */
export const OverTranscript: Story = {
  name: 'Over transcript (composite)',
  render: () => (
    <div className="relative h-screen w-full bg-background">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
        <div className="ml-auto max-w-[70%] rounded-2xl bg-primary px-4 py-2.5 text-sm text-primary-foreground">
          Render the launch poster and queue it for review.
        </div>
        <div className="max-w-[85%] text-sm leading-6 text-foreground">
          On it. I rendered the poster from the current scene and submitted it for approval. Here is what I ran —
          click a tool card to drill into the transcript:
        </div>
        <div className="max-w-[85%] rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-muted-foreground">
          sandbox_run_command · render --page page-1 --format png — done
        </div>
        <div className="max-w-[85%] rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-muted-foreground">
          submit_proposal · Launch poster — queued for approval
        </div>
      </div>
      <RunDrillIn run={completedToolRun} onClose={() => console.log('close drill-in')} />
    </div>
  ),
}
