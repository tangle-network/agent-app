import { useId } from 'react'

export interface SharedLineApp {
  /** Stable app identity used to collapse duplicate registrations. */
  id: string
  name: string
}

export interface SharedLineAppNoticeProps {
  /** Apps the host has verified can handle this same phone conversation. */
  apps: readonly SharedLineApp[]
  /** The host controls dismissal so the choice can persist with its own policy. */
  open: boolean
  onKeepSharing(): void
  /** Omit when the host has no supported dedicated-number flow. */
  onRequestDedicatedNumber?: () => void
}

function distinctApps(apps: readonly SharedLineApp[]): SharedLineApp[] {
  const seen = new Set<string>()
  const result: SharedLineApp[] = []

  for (const app of apps) {
    const id = app.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push({ id, name: app.name.trim() || 'Unnamed app' })
  }

  return result
}

/** A quiet, dismissible notice for apps that the host verified share a phone thread. */
export function SharedLineAppNotice({
  apps,
  open,
  onKeepSharing,
  onRequestDedicatedNumber,
}: SharedLineAppNoticeProps) {
  const titleId = useId()
  const sharingApps = distinctApps(apps)
  if (!open || sharingApps.length < 2) return null

  return (
    <section className="tangle-lines agent-shared-line-notice" aria-labelledby={titleId}>
      <div className="agent-shared-line-notice__copy">
        <h2 id={titleId}>These apps share one text conversation</h2>
        <p>Each app keeps its own history here. Their replies appear together in the same conversation on your phone.</p>
        <ul className="agent-shared-line-notice__apps" aria-label="Apps sharing this conversation">
          {sharingApps.map(app => <li key={app.id}>{app.name}</li>)}
        </ul>
      </div>
      <div className="agent-shared-line-notice__actions">
        {onRequestDedicatedNumber && (
          <button
            className="agent-shared-line-notice__secondary"
            type="button"
            onClick={onRequestDedicatedNumber}
          >
            Get a dedicated number
          </button>
        )}
        <button className="agent-shared-line-notice__primary" type="button" onClick={onKeepSharing}>
          Keep sharing
        </button>
      </div>
    </section>
  )
}
