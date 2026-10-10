import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@tangle-network/ui/primitives'

import { hubActionReceipt, presentHubAction, type HubApprovalItem } from '../hub-approvals'
import { HUB_APPROVAL_UNKNOWN_WARNING } from '../hub-approvals/unknown'
import { HubApprovalPhasePill, HubProviderMark, HubRawDetails } from './parts'
import { HubActionPreviewView } from './preview'
import { HubActionReceiptCard } from './receipt'

export interface HubApprovalRowProps {
  item: HubApprovalItem
  /** Open the detail, e.g. when the call was picked in the Approvals list. */
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  /** Bring a waiting call to the front of the dock. */
  onReview?: (item: HubApprovalItem) => void
  /** Extra controls for settled calls; suppressed for unknown outcomes to prevent unsafe retries. */
  actions?: ReactNode
}

/**
 * A held call where the agent made it: one line with the integration, what
 * the call does and where it stands, opening to its preview, result and the
 * exact call. The decision itself lives in the dock, so the transcript stays
 * readable while a request waits.
 */
export function HubApprovalRow({ item, expanded: controlled, onExpandedChange, onReview, actions }: HubApprovalRowProps) {
  const [own, setOwn] = useState(false)
  const expanded = controlled ?? own
  const ref = useRef<HTMLDivElement>(null)
  const presentation = presentHubAction(item)
  const title = item.phase === 'done' ? hubActionReceipt(item).title : presentation.title

  useEffect(() => {
    if (controlled) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [controlled])

  const toggle = () => {
    setOwn(!expanded)
    onExpandedChange?.(!expanded)
  }

  return (
    <div ref={ref} data-hub-approval-row={item.id} className={`rounded-xl border bg-card ${expanded ? 'border-border shadow-sm' : 'border-border/80'}`}>
      <div className="flex items-center gap-3 px-3 py-2">
        <Button
          variant="bare"
          aria-expanded={expanded}
          onClick={toggle}
          className="flex min-h-9 min-w-0 flex-1 items-center gap-3 rounded-md text-left"
        >
          <HubProviderMark providerId={presentation.provider.id} name={presentation.provider.name} size={24} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</span>
          <HubApprovalPhasePill phase={item.phase} label={item.phase === 'waiting' ? 'Waiting' : item.phase === 'blocked' ? 'Owner decides' : undefined} />
          <ChevronDown aria-hidden className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </Button>
        {item.phase === 'waiting' && onReview && (
          // On a phone the dock sits just below; the row keeps its width for the title.
          <Button variant="outline" className="hidden sm:inline-flex" onClick={() => onReview(item)}>Review</Button>
        )}
      </div>
      {!expanded && item.phase === 'unknown' && (
        <p className="px-3 pb-3 text-sm text-[var(--surface-warning-text)]">{HUB_APPROVAL_UNKNOWN_WARNING}</p>
      )}
      {expanded && (
        <div className="space-y-3 border-t border-border px-3 pb-3 pt-3">
          {item.phase === 'done' || item.phase === 'failed' || item.phase === 'unknown'
            ? <HubActionReceiptCard item={item} className="border-0 px-0 py-0 shadow-none" />
            : (
                <>
                  <HubActionPreviewView preview={presentation.preview} account={item.account} />
                  <HubRawDetails sections={[{ label: 'Call', value: { action: item.actionPath, input: item.input } }]} />
                </>
              )}
          {item.phase !== 'unknown' && actions}
        </div>
      )}
      {!expanded && actions && (item.phase === 'expired' || item.phase === 'failed') && (
        <div className="border-t border-border px-3 py-2">{actions}</div>
      )}
    </div>
  )
}
