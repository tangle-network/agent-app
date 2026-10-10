import { useEffect, useState } from 'react'
import { ChevronRight, ShieldCheck } from 'lucide-react'
import { Button } from '@tangle-network/ui/primitives'

import { hubActionReceipt, presentHubAction, type HubApprovalItem, type HubApprovalPhase } from '../hub-approvals'
import { HUB_APPROVAL_UNKNOWN_WARNING } from '../hub-approvals/unknown'
import { closesIn, distinctAccount, HubApprovalPhasePill, HubProviderMark, openPhaseLabel, relativeTime } from './parts'

const GROUPS: ReadonlyArray<{ id: string; label: string; phases: readonly HubApprovalPhase[] }> = [
  { id: 'waiting', label: 'Waiting', phases: ['waiting', 'blocked'] },
  { id: 'running', label: 'Running', phases: ['queued', 'running'] },
  // Uncertain effects need provider verification, separate from confirmed failures.
  { id: 'unknown', label: 'May have run', phases: ['unknown'] },
  { id: 'failed', label: 'Failed', phases: ['failed'] },
  { id: 'done', label: 'Done', phases: ['done'] },
  { id: 'closed', label: 'Denied or expired', phases: ['denied', 'expired'] },
]

export interface HubApprovalsListProps {
  items: readonly HubApprovalItem[]
  /** Show one call: scroll to it in the conversation and open its detail. */
  onSelect?: (item: HubApprovalItem) => void
  selectedId?: string | null
  className?: string
}

/**
 * Every held call in the conversation, grouped by where it stands — waiting,
 * running, failed, done, then denied or expired — and updated as the host's
 * items change. Picking one hands it to `onSelect`.
 */
export function HubApprovalsList({ items, onSelect, selectedId, className = '' }: HubApprovalsListProps) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  const waiting = items.filter((item) => item.phase === 'waiting' || item.phase === 'blocked').length
  const groups = GROUPS
    .map((group) => ({ ...group, items: items.filter((item) => group.phases.includes(item.phase)).slice().reverse() }))
    .filter((group) => group.items.length > 0)

  return (
    <div className={`flex h-full min-h-0 flex-col ${className}`}>
      <div className="shrink-0 border-b border-border px-4 py-3">
        <h2 className="text-base font-semibold text-foreground">Approvals</h2>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {waiting === 0 ? 'Nothing is waiting for you' : waiting === 1 ? '1 request is waiting' : `${waiting} requests are waiting`}
        </p>
      </div>
      {groups.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          <span className="flex size-10 items-center justify-center rounded-xl bg-muted"><ShieldCheck aria-hidden className="size-5 text-muted-foreground" /></span>
          <p className="text-sm font-medium text-foreground">No approvals in this conversation</p>
          <p className="text-sm text-muted-foreground">Requests to act on your connected accounts appear here.</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-2 py-3">
          {groups.map((group) => (
            <section key={group.id} aria-label={group.label}>
              <h3 className="px-2 pb-1 text-sm font-medium text-muted-foreground">
                {group.label} <span className="tabular-nums">· {group.items.length}</span>
              </h3>
              <ul className="space-y-1">
                {group.items.map((item) => {
                  const presentation = presentHubAction(item)
                  const title = item.phase === 'done' ? hubActionReceipt(item).title : presentation.title
                  const when = item.phase === 'waiting' ? closesIn(item.expiresAt, now) ?? relativeTime(item.requestedAt, now) : relativeTime(item.requestedAt, now)
                  const detail = [presentation.provider.name, distinctAccount(item.account, presentation.provider.name), when].filter(Boolean).join(' · ')
                  const selected = selectedId === item.id
                  return (
                    <li key={item.id}>
                      <Button
                        variant="bare"
                        onClick={() => onSelect?.(item)}
                        aria-current={selected ? 'true' : undefined}
                        className={`flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-muted ${selected ? 'bg-muted' : ''}`}
                      >
                        <HubProviderMark providerId={presentation.provider.id} name={presentation.provider.name} size={28} />
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2 text-sm font-medium leading-5 text-foreground">{title}</span>
                          <span className="mt-0.5 block truncate text-sm text-muted-foreground">{detail}</span>
                          {item.phase === 'unknown' && <span className="mt-1 block text-sm text-[var(--surface-warning-text)]">{HUB_APPROVAL_UNKNOWN_WARNING}</span>}
                          {(item.phase === 'waiting' || item.phase === 'blocked') && item.wait && <span className="mt-1 line-clamp-2 block text-sm text-muted-foreground">{item.wait.reason}</span>}
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          <HubApprovalPhasePill phase={item.phase} label={openPhaseLabel(item, 'Owner')} />
                          <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
                        </span>
                      </Button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
