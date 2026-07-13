import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@tangle-network/sandbox-ui/primitives'
import { type Generation } from '../studio'
import { typeConfigFor } from './type-config'
import { GenerationDetail } from './generation-detail'

/**
 * Centered detail view for a single generation. Opens when `generation` is set
 * and reports dismissal through `onClose`. GenerationDetail renders the media,
 * type badge, prompt and metadata; the dialog title carries the a11y label.
 */
export function GenerationDetailModal({
  generation,
  vaultHref,
  onClose,
}: {
  generation: Generation | null
  vaultHref?: (filePath?: string | null) => string
  onClose: () => void
}) {
  const cfg = generation ? typeConfigFor(generation.type) : null
  return (
    <Dialog open={generation != null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-left text-base">{cfg?.label ?? 'Generation'}</DialogTitle>
        </DialogHeader>
        {generation && (
          <GenerationDetail generation={generation} vaultHref={vaultHref} onNavigate={onClose} />
        )}
      </DialogContent>
    </Dialog>
  )
}
