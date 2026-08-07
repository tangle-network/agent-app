import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { ResizeHandle } from '../../assistant/ResizeHandle'

/**
 * The drawer's drag-to-resize grip, mounted on the left edge of a stand-in
 * panel — the same wiring the dock uses (`usePanelWidth`), minus the
 * localStorage persistence: preview on every move, commit once on release,
 * arrow keys nudge in 24px steps when the grip is focused.
 */
const meta: Meta<typeof ResizeHandle> = {
  title: 'Assistant/ResizeHandle',
  component: ResizeHandle,
  parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj<typeof ResizeHandle>

const MIN_WIDTH = 360
const MAX_WIDTH = 720

function clampWidth(w: number): number {
  return Math.min(Math.max(Math.round(w), MIN_WIDTH), MAX_WIDTH)
}

function ResizeHarness() {
  const [width, setWidth] = useState(440)
  return (
    <div className="flex h-screen flex-col">
      <p className="shrink-0 px-4 py-2 text-muted-foreground text-xs">
        Drag the grip on the panel’s left edge, or focus it and press ← / →.
        Committed width logs to the console ({MIN_WIDTH}–{MAX_WIDTH}px).
      </p>
      <div className="relative flex min-h-0 flex-1 justify-end bg-secondary">
        <div
          className="relative flex h-full flex-col border-border border-l bg-background shadow-xl"
          style={{ width }}
        >
          <ResizeHandle
            width={width}
            maxWidth={MAX_WIDTH}
            onPreview={(next) => setWidth(clampWidth(next))}
            onCommit={(next) => {
              const clamped = clampWidth(next)
              setWidth(clamped)
              console.log('[story] commit width', clamped)
            }}
            onNudge={(delta) => setWidth((w) => clampWidth(w + delta))}
          />
          <div className="border-border border-b px-4 py-3">
            <span className="font-medium text-foreground text-sm">Assistant</span>
          </div>
          <div className="flex flex-1 items-center justify-center p-4">
            <span className="text-muted-foreground text-sm">{width}px wide</span>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Drag the panel's left edge, or focus the grip and use ← / →. The committed
 *  width logs on release. */
export const Interactive: Story = {
  name: 'Interactive',
  render: () => <ResizeHarness />,
}
