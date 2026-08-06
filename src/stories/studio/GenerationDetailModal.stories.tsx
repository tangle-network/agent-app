import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'
import { GenerationDetailModal } from '../../studio-react'
import type { Generation } from '../../studio'
import { demoVaultHref, teaserA, transcriptionGeneration } from './fixtures'

/**
 * The modal portals into the canvas and opens whenever `generation` is set.
 * Each demo keeps the selection in local state so closing (Escape / outside
 * click) blanks it and the story offers a reopen button.
 */
function ModalDemo({ initial }: { initial: Generation }) {
  const [generation, setGeneration] = useState<Generation | null>(initial)
  return (
    <MemoryRouter>
      <div className="flex h-64 items-center justify-center">
        <button
          type="button"
          onClick={() => setGeneration(initial)}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground"
        >
          Open generation detail
        </button>
      </div>
      <GenerationDetailModal
        generation={generation}
        vaultHref={demoVaultHref}
        onClose={() => {
          console.log('onClose')
          setGeneration(null)
        }}
      />
    </MemoryRouter>
  )
}

const meta: Meta<typeof GenerationDetailModal> = {
  title: 'Studio/GenerationDetailModal',
  component: GenerationDetailModal,
  parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj<typeof GenerationDetailModal>

export const ImageOpen: Story = {
  name: 'Open — image',
  render: () => <ModalDemo initial={teaserA} />,
}

export const TranscriptionOpen: Story = {
  name: 'Open — transcription',
  render: () => <ModalDemo initial={transcriptionGeneration} />,
}
