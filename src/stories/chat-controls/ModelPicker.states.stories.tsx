import type { Meta, StoryObj } from '@storybook/react'
import { useEffect, useState } from 'react'
import userEvent from '@testing-library/user-event'
import { ModelPicker } from '../../web-react'
import { AutoClick, catalogModels, DEFAULT_MODEL_ID, withPopoverHeadroom } from './fixtures'

const meta: Meta<typeof ModelPicker> = {
  title: 'ChatControls/ModelPicker',
  component: ModelPicker,
  parameters: { layout: 'centered' },
  decorators: [withPopoverHeadroom],
}
export default meta
type Story = StoryObj<typeof ModelPicker>

/** A host-owned retry simulation, not a catalogue client inside the picker. */
function RecoveryDemo() {
  const [state, setState] = useState<'error' | 'loading' | 'ready'>('error')
  const [value, setValue] = useState('private/retained-model')
  useEffect(() => {
    if (state !== 'loading') return
    const timer = setTimeout(() => setState('ready'), 800)
    return () => clearTimeout(timer)
  }, [state])
  return (
    <div className="w-[340px] max-w-[calc(100vw-3rem)] space-y-3">
      <label htmlFor="recovery-model" className="block text-sm font-medium text-foreground">Default model</label>
      <p id="recovery-help" className="text-sm text-muted-foreground">Retry does not replace your saved model.</p>
      <div className="overflow-x-auto p-1">
        <ModelPicker id="recovery-model" aria-describedby="recovery-help" value={value} onChange={setValue}
          models={state === 'ready' ? catalogModels : []} loading={state === 'loading'}
          error={state === 'error' ? 'The catalogue could not be loaded. Check your connection and retry.' : null}
          onRetry={() => setState('loading')} />
      </div>
      <output aria-label="Saved model" className="block break-words text-xs text-muted-foreground">{value}</output>
      <button type="button" className="rounded-md border border-border px-3 py-2 text-sm text-foreground">Next setting</button>
    </div>
  )
}

export const Recovery: Story = {
  render: () => <AutoClick><RecoveryDemo /></AutoClick>,
}

export const Unavailable: Story = {
  render: () => <AutoClick><ModelPicker value="private/retained-model" onChange={() => {}}
    models={[]} error="The catalogue is unavailable. Your saved configuration has not changed." /></AutoClick>,
}

export const EmptyCatalogue: Story = {
  render: () => <AutoClick><ModelPicker value="private/retained-model" onChange={() => {}} models={[]} /></AutoClick>,
}

export const NoSearchMatches: Story = {
  args: { value: DEFAULT_MODEL_ID, onChange: () => {}, models: catalogModels },
  play: async ({ canvasElement }) => {
    const user = userEvent.setup({ document: canvasElement.ownerDocument })
    const trigger = canvasElement.querySelector('button')
    if (!trigger) throw new Error('ModelPicker trigger was not rendered')
    await user.click(trigger)
    const input = canvasElement.ownerDocument.querySelector<HTMLInputElement>('input[aria-label="Search all models"]')
    if (!input) throw new Error('ModelPicker search was not rendered')
    await user.type(input, 'no-matching-model-12345')
  },
}

export const LongModelNames: Story = {
  render: () => <AutoClick><ModelPicker value={'private/' + 'retained-model-'.repeat(10)} onChange={() => {}}
    models={[{ ...catalogModels[0]!, featured: true,
      name: 'Research specialist — extended context, multilingual analysis and carefully verified tool use with a very long descriptive model name',
    }, ...catalogModels.slice(1)]} /></AutoClick>,
}

export const Disabled: Story = {
  render: () => <div className="space-y-3">
    <p id="disabled-model-help" className="text-sm text-muted-foreground">Model changes are disabled while this setting is being saved.</p>
    <div className="flex flex-wrap gap-3">
      <ModelPicker value={DEFAULT_MODEL_ID} onChange={() => {}} models={catalogModels} disabled aria-describedby="disabled-model-help" />
      <ModelPicker value="private/retained-model" onChange={() => {}} models={[]} disabled variant="quiet" aria-describedby="disabled-model-help" triggerContent={<span>Search</span>} />
    </div>
  </div>,
}
