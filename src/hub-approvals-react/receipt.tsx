import { useState } from 'react'
import { ExternalLink } from 'lucide-react'

import { hubActionReceipt, presentHubAction, type HubApprovalItem, type HubApprovalPhase } from '../hub-approvals'
import { HubApprovalPhasePill, HubDiffSummary, HubFieldList, HubProviderMark, HubRawDetails } from './parts'

function AudioPlayer({ src }: { src: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <p className="text-sm text-muted-foreground">The audio link has expired. Ask the agent for a new one.</p>
  // The memo is generated speech with its text shown beside it, so it carries no caption track.
  // eslint-disable-next-line jsx-a11y/media-has-caption
  return <audio controls preload="metadata" src={src} onError={() => setFailed(true)} className="h-10 w-full" />
}

export interface HubActionReceiptCardProps {
  item: HubApprovalItem
  className?: string
}

/**
 * What one decided Hub action did: the integration's logo, the result in plain
 * words with its link, the key fields, a player or file changes when the
 * result has them, and the exact call and result behind Details.
 */
export function HubActionReceiptCard({ item, className = '' }: HubActionReceiptCardProps) {
  const receipt = hubActionReceipt(item)
  const presentation = presentHubAction(item)
  const subtitle = [receipt.provider.name, item.account ? `as ${item.account}` : null, presentation.target && !receipt.title.includes(presentation.target) ? presentation.target : null]
    .filter(Boolean).join(' · ')
  const phase: HubApprovalPhase = item.phase
  return (
    <article aria-label={receipt.title} className={`rounded-xl border border-border bg-card px-4 py-3 shadow-sm ${className}`}>
      <div className="flex items-start gap-3">
        <HubProviderMark providerId={receipt.provider.id} name={receipt.provider.name} />
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold leading-6 text-foreground">
            {receipt.href
              ? (
                  <a href={receipt.href} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1.5 hover:underline">
                    <span className="truncate">{receipt.title}</span>
                    <ExternalLink aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  </a>
                )
              : <span className="break-words">{receipt.title}</span>}
          </p>
          {subtitle && <p className="truncate text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        <HubApprovalPhasePill phase={phase} />
      </div>
      {(receipt.fields.length > 0 || receipt.media || receipt.files || receipt.error) && (
        <div className="mt-3 space-y-3">
          <HubFieldList fields={receipt.fields} />
          {receipt.media && <AudioPlayer src={receipt.media.src} />}
          {receipt.files && <HubDiffSummary files={receipt.files} />}
          {receipt.error && (
            <p className="break-words rounded-lg border border-[var(--surface-danger-border)] bg-[var(--surface-danger-bg)] px-3 py-2 text-sm text-[var(--surface-danger-text)]">
              {receipt.error}
            </p>
          )}
        </div>
      )}
      {(item.grant || item.autoApproved) && (
        <p className="mt-3 text-sm text-muted-foreground">
          {item.autoApproved ?? `Allowed ${item.grant?.expiresAt ? 'for 24 hours' : 'from now on'}: ${item.grant?.scope}`}
        </p>
      )}
      <div className="mt-2">
        <HubRawDetails sections={[
          { label: 'Call', value: { action: item.actionPath, input: item.input } },
          { label: 'Result', value: item.result },
        ]} />
      </div>
    </article>
  )
}

export interface HubApprovalReceiptsProps {
  items: readonly HubApprovalItem[]
  /** The message the agent received, shown behind Details so nothing it read is hidden. */
  message?: string
  /** When the decisions were sent. */
  at?: string | Date | null
}

/**
 * The receipts that stand in for the message resuming the agent after a
 * decision. The agent gets that message unchanged; the transcript shows what
 * happened instead of the machine prompt.
 */
export function HubApprovalReceipts({ items, message, at }: HubApprovalReceiptsProps) {
  const decided = items.filter((item) => item.phase !== 'waiting' && item.phase !== 'blocked')
  const count = (phases: readonly HubApprovalPhase[]) => decided.filter((item) => phases.includes(item.phase)).length
  const actions = (n: number) => (n === 1 ? '1 action' : `${n} actions`)
  const approved = count(['queued', 'running', 'done', 'failed'])
  const denied = count(['denied'])
  const expired = count(['expired'])
  const verbs = [approved ? `approved ${actions(approved)}` : null, denied ? `denied ${actions(denied)}` : null].filter(Boolean)
  const summary = verbs.length
    ? `You ${verbs.join(' and ')}${expired ? `; ${actions(expired)} expired` : ''}`
    : `${actions(expired)} expired`
  const when = at ? new Date(at) : null
  return (
    <section aria-label="Approval results" className="space-y-2">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>{summary}</span>
        {when && !Number.isNaN(when.getTime()) && (
          <time dateTime={when.toISOString()}>· {when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
        )}
      </p>
      {decided.map((item) => <HubActionReceiptCard key={item.id} item={item} />)}
      {message && <HubRawDetails sections={[{ label: 'Message sent to the agent', value: message }]} />}
    </section>
  )
}
