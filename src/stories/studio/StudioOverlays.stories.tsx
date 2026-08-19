import type { Meta, StoryObj } from '@storybook/react'
import { useEffect, useRef, useState } from 'react'

import { StudioConfirmDialog } from '../../studio-react/studio-confirm'
import { MediaViewerModal } from '../../studio-react/media-viewer'
import { useStudioToast } from '../../studio-react/studio-toasts'
import { VaultPathPopover } from '../../studio-react/vault-path-popover'
import { teaserBatch } from './fixtures'
import { StudioProviders, storyMediaActions } from './StudioProviders'

function OverlayLadder() {
  const [vaultOpen, setVaultOpen] = useState(true)
  const [confirmOpen, setConfirmOpen] = useState(true)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const { toast } = useStudioToast()

  useEffect(() => {
    toast({
      message: 'Saved to vault · generated/images/launch-campaign',
      action: { label: 'Undo', run: () => console.log('undo') },
      durationMs: 0,
    })
  }, [toast])

  return (
    <>
      <div className="fixed right-6 top-6 z-[950] flex gap-2">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setVaultOpen((open) => !open)}
          className="h-8 rounded-full border border-border bg-card px-3 text-[13px] shadow-sm"
        >
          Toggle vault path
        </button>
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          className="h-8 rounded-full border border-border bg-card px-3 text-[13px] shadow-sm"
        >
          Show confirm
        </button>
      </div>

      <MediaViewerModal
        generation={teaserBatch[0]!}
        onClose={() => console.log('close viewer')}
        actions={storyMediaActions}
        onRequestDelete={() => setConfirmOpen(true)}
      />
      <VaultPathPopover
        open={vaultOpen}
        triggerRef={triggerRef}
        panelRef={panelRef}
        generations={[teaserBatch[0]!]}
        onSubmit={(path) => {
          setVaultOpen(false)
          toast({ message: `Saved to vault · ${path}`, durationMs: 0 })
        }}
        onCancel={() => setVaultOpen(false)}
      />
      <StudioConfirmDialog
        open={confirmOpen}
        count={1}
        onConfirm={() => setConfirmOpen(false)}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  )
}

const meta: Meta<typeof OverlayLadder> = {
  title: 'Studio/StudioOverlays',
  component: OverlayLadder,
  decorators: [
    (Story) => (
      <StudioProviders>
        <div className="min-h-screen bg-accent/30"><Story /></div>
      </StudioProviders>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component: 'Viewer at layer 900, vault popover at 1000, confirm at 1100, and the persistent toast at 1200. Cancel the confirm to use the two story controls.',
      },
    },
  },
}

export default meta
type Story = StoryObj<typeof OverlayLadder>

export const LayerLadder: Story = {
  name: 'Layer ladder',
}
