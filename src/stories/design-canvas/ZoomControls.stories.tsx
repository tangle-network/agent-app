import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { ZoomControls } from '../../design-canvas-react'

/**
 * Fit / zoom-out / percent readout (click resets to 100%) / zoom-in.
 * Stateless — the editor owns zoom; these stories drive it with local state.
 */
const meta: Meta<typeof ZoomControls> = {
  title: 'Design Canvas/ZoomControls',
  component: ZoomControls,
  decorators: [
    (Story) => (
      <div className="rounded-md border border-[var(--border-default)] bg-[var(--bg-input)] p-2">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof ZoomControls>

const onFit = () => console.log('[zoom story] fit to screen')

/** Mid-range zoom: every control enabled. */
export const Default: Story = {
  render: () => <ZoomControls zoom={1} onZoom={(zoom) => console.log('[zoom story] zoom', zoom)} onFit={onFit} />,
}

/** Zoomed out (multi-page documents sit here): 35%. */
export const ZoomedOut: Story = {
  name: 'Zoomed out',
  render: () => <ZoomControls zoom={0.35} onZoom={(zoom) => console.log('[zoom story] zoom', zoom)} onFit={onFit} />,
}

/** At the 5% floor: zoom-out disables. */
export const MinZoom: Story = {
  name: 'Min zoom (out disabled)',
  render: () => <ZoomControls zoom={0.05} onZoom={(zoom) => console.log('[zoom story] zoom', zoom)} onFit={onFit} />,
}

/** At the 3200% ceiling: zoom-in disables. */
export const MaxZoom: Story = {
  name: 'Max zoom (in disabled)',
  render: () => <ZoomControls zoom={32} onZoom={(zoom) => console.log('[zoom story] zoom', zoom)} onFit={onFit} />,
}

/** Percent readout and ± steppers drive local state. */
export const Interactive: Story = {
  render: function InteractiveZoom() {
    const [zoom, setZoom] = useState(1)
    return <ZoomControls zoom={zoom} onZoom={setZoom} onFit={() => setZoom(0.62)} />
  },
}

/** The four boundary/mid states side by side. */
export const AllStates: Story = {
  name: 'All states (composite)',
  decorators: [],
  render: () => (
    <div className="flex items-center gap-4">
      {[
        { label: '100%', zoom: 1 },
        { label: '35%', zoom: 0.35 },
        { label: '5% — min', zoom: 0.05 },
        { label: '3200% — max', zoom: 32 },
      ].map((cell) => (
        <div key={cell.label} className="flex flex-col items-start gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{cell.label}</span>
          <div className="rounded-md border border-[var(--border-default)] bg-[var(--bg-input)] p-2">
            <ZoomControls zoom={cell.zoom} onZoom={(zoom) => console.log('[zoom story] zoom', zoom)} onFit={onFit} />
          </div>
        </div>
      ))}
    </div>
  ),
}
