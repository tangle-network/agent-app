import { useEffect, useRef } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { ExportControl } from '../../design-canvas-react'
import type { ExportControlProps } from '../../design-canvas-react'

/**
 * The chrome's export popover: format (PNG/JPEG) × scale (1x/2x). The control
 * only collects options — the workspace owns the Konva stage and renders the
 * data URL — so these stories log the chosen options.
 */
const meta: Meta<typeof ExportControl> = {
  title: 'Design Canvas/ExportControl',
  component: ExportControl,
}

export default meta
type Story = StoryObj<typeof ExportControl>

const onExport: ExportControlProps['onExport'] = (opts) => console.log('[export story] export', opts)

/** Wraps the control and clicks its trigger on mount so the popover story
 *  renders open (the component owns `open` internally — no prop override). */
function OpenExportControl(props: ExportControlProps) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector('button')?.click()
  }, [])
  return (
    <div ref={ref} className="flex justify-end">
      <ExportControl {...props} />
    </div>
  )
}

/** Closed trigger, as it sits in the editor's top-right chrome slot. */
export const Closed: Story = {
  render: () => (
    <div className="flex justify-end rounded-md border border-[var(--border-default)] bg-[var(--bg-input)] p-2">
      <ExportControl onExport={onExport} />
    </div>
  ),
}

/** Popover open with the default PNG @ 1x selection. */
export const Open: Story = {
  decorators: [(Story) => <div className="h-[240px] w-[320px] p-2"><Story /></div>],
  render: () => <OpenExportControl onExport={onExport} />,
}

/** Popover open with host-supplied defaults (JPEG @ 2x) pre-selected. */
export const OpenWithDefaults: Story = {
  name: 'Open — JPEG @ 2x defaults',
  decorators: [(Story) => <div className="h-[240px] w-[320px] p-2"><Story /></div>],
  render: () => <OpenExportControl onExport={onExport} defaults={{ format: 'jpeg', pixelRatio: 2 }} />,
}

/** Trigger plus both popover configurations in one glance. */
export const AllStates: Story = {
  name: 'All states (composite)',
  // Trigger + open-popover cells side by side — left-anchored so nothing clips.
  parameters: { layout: 'padded' },
  render: () => (
    <div className="flex items-start gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Closed</span>
        <div className="flex w-[200px] justify-end rounded-md border border-[var(--border-default)] bg-[var(--bg-input)] p-2">
          <ExportControl onExport={onExport} />
        </div>
      </div>
      {[
        { label: 'Open — PNG @ 1x', defaults: undefined },
        { label: 'Open — JPEG @ 2x', defaults: { format: 'jpeg', pixelRatio: 2 } as const },
      ].map((cell) => (
        <div key={cell.label} className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{cell.label}</span>
          <div className="h-[230px] w-[260px] rounded-md border border-[var(--border-default)] p-2">
            <OpenExportControl onExport={onExport} defaults={cell.defaults} />
          </div>
        </div>
      ))}
    </div>
  ),
}
