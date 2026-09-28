import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { ConfirmDialog } from '../../vault/ConfirmDialog'

function KeyboardConfirmation({ create = false }: { create?: boolean }) {
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState('')
  const [outcome, setOutcome] = useState('No action selected')
  return (
    <div className="p-6">
      <button
        type="button"
        className="rounded bg-primary px-3 py-2 text-primary-foreground"
        onClick={() => { setOpen(true); setOutcome('No action selected') }}
      >
        {create ? 'Create file' : 'Discard draft'}
      </button>
      <p role="status" className="mt-3 text-sm">{outcome}</p>
      <ConfirmDialog
        open={open}
        title={create ? 'Create file' : 'Discard unsaved changes?'}
        description={create ? 'Enter a file path, then choose Create or Cancel.' : 'Discard the current draft or keep editing.'}
        confirmLabel={create ? 'Create' : 'Discard changes'}
        destructive={!create}
        confirmDisabled={create && !path.trim()}
        onConfirm={() => {
          setOutcome(create ? 'Create selected: ' + path : 'Discard selected')
          setOpen(false)
        }}
        onCancel={() => { setOutcome('Cancel selected'); setOpen(false) }}
      >
        {create && (
          <div className="space-y-2">
            <input
              aria-label="New file path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              className="h-9 w-full rounded border border-border bg-background px-3"
            />
            {/* Public dialog children do not require form-aware button markup. */}
            <button
              className="rounded border border-border px-3 py-2 text-sm"
              onClick={() => { setPath('notes.md'); setOutcome('Template selected') }}
            >
              Use template
            </button>
          </div>
        )}
      </ConfirmDialog>
    </div>
  )
}

const meta: Meta<typeof KeyboardConfirmation> = {
  title: 'Vault/Keyboard confirmation',
  component: KeyboardConfirmation,
  parameters: {
    docs: {
      description: {
        component: 'Keyboard interaction states only. These stories report the selected action and do not write files.',
      },
    },
  },
}
export default meta

export const DiscardDraft: StoryObj<typeof KeyboardConfirmation> = {}
export const CreateFile: StoryObj<typeof KeyboardConfirmation> = {
  args: { create: true },
}
