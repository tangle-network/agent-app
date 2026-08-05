import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { ComposerDisclosure, Field, NativeSelect, Stepper } from '../../studio-react'
import { Input } from '@tangle-network/sandbox-ui/primitives'

const meta: Meta<typeof Stepper> = {
  title: 'Studio/ComposerShell',
  component: Stepper,
  decorators: [
    (Story) => (
      <div className="w-[420px] p-4">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof Stepper>

/** The stepper clamps between min and max (image count uses 1–4). */
export const StepperInteractive: Story = {
  name: 'Stepper',
  render: function StepperDemo() {
    const [value, setValue] = useState(2)
    return <Stepper value={value} min={1} max={4} onChange={setValue} />
  },
}

/** Field + NativeSelect + disclosure as the composers assemble them. */
export const ShellPieces: Story = {
  name: 'Field / NativeSelect / Disclosure',
  render: () => (
    <div className="space-y-4">
      <Field label="Save to" htmlFor="demo-save-to">
        <Input id="demo-save-to" defaultValue="generated/images" className="bg-background" />
      </Field>
      <Field label="Response format">
        <NativeSelect defaultValue="json" onChange={(event) => console.log('format', event.target.value)}>
          <option value="json">JSON</option>
          <option value="text">Text</option>
          <option value="srt">SRT</option>
        </NativeSelect>
      </Field>
      <ComposerDisclosure summary="Advanced options">
        <p className="text-xs text-muted-foreground">
          Disclosure body — the chevron rotates open. Used for "Advanced options" and "Schedule a post".
        </p>
      </ComposerDisclosure>
    </div>
  ),
}
