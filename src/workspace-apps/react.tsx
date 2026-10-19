/**
 * Browser parts of cloud artifacts: the frame that renders one from the
 * artifact origin, and the owner's public-link control. Products supply the
 * minted view URL and the share calls; authorization stays on the server.
 */
import { useState } from 'react'
import { Button, CopyButton, Input } from '@tangle-network/ui/primitives'
import type { MutationOutcome } from '../web-react/async/use-confirmed-mutation'
import { CLOUD_ARTIFACT_FRAME_SANDBOX } from './cloud-artifact-origin'

export { CLOUD_ARTIFACT_FRAME_SANDBOX }

/** Render a cloud artifact from its view URL on the artifact origin. */
export function CloudArtifactFrame({ src, title, className }: {
  /** A view URL the server minted for this viewer (`createCloudArtifactViewUrl`). */
  src: string
  title: string
  className?: string
}) {
  return (
    <iframe
      src={src}
      title={title}
      className={className ?? 'h-full w-full border-0 bg-white'}
      sandbox={CLOUD_ARTIFACT_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      allow="fullscreen; clipboard-write"
    />
  )
}

/** A live public link to one artifact. */
export interface CloudArtifactPublicLink {
  id: string
  url: string
  createdAt: string
}

export interface CloudArtifactSharePanelProps {
  link: CloudArtifactPublicLink | null
  /** Whether this viewer may create or revoke the link (`CLOUD_ARTIFACT_SHARE_ROLE`). */
  canShare: boolean
  onCreate(): Promise<MutationOutcome<CloudArtifactPublicLink>>
  onRevoke(link: CloudArtifactPublicLink): Promise<MutationOutcome<unknown>>
}

/** Turn an artifact's public link on, copy it, or turn it off. */
export function CloudArtifactSharePanel({ link: initial, canShare, onCreate, onRevoke }: CloudArtifactSharePanelProps) {
  const [link, setLink] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    setBusy(true)
    setError(null)
    const outcome = await onCreate()
    setBusy(false)
    if (outcome.succeeded) setLink(outcome.value)
    else setError(outcome.message)
  }
  const revoke = async () => {
    if (!link) return
    setBusy(true)
    setError(null)
    const outcome = await onRevoke(link)
    setBusy(false)
    if (outcome.succeeded) setLink(null)
    else setError(outcome.message)
  }

  return (
    <section aria-labelledby="cloud-artifact-share-title" className="flex flex-col gap-3 text-sm">
      <div>
        <h2 id="cloud-artifact-share-title" className="text-sm font-semibold text-foreground">Public link</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {link
            ? 'Anyone with this link can open the page. Turning it off stops the link right away.'
            : 'Only members of this workspace can open this page.'}
        </p>
      </div>
      {link ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input readOnly value={link.url} aria-label="Public link" className="min-w-0 flex-1 text-sm" onFocus={(event) => event.currentTarget.select()} />
          <div className="flex shrink-0 gap-2">
            <CopyButton text={link.url} label="Copy link" copiedLabel="Copied" />
            {canShare && (
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void revoke()}>
                {busy ? 'Turning off…' : 'Turn off link'}
              </Button>
            )}
          </div>
        </div>
      ) : canShare ? (
        <div>
          <Button type="button" size="sm" disabled={busy} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create public link'}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Editors and owners can share it.</p>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </section>
  )
}
