import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ExternalLink, Loader2, X } from 'lucide-react'
import { Button, Label, RadioGroup, RadioGroupItem } from '@tangle-network/ui/primitives'

import {
  HUB_APPROVAL_ACTIVE_PHASES,
  HUB_APPROVAL_OPEN_PHASES,
  hubActionReceipt,
  presentHubAction,
  type HubApprovalItem,
  type HubApprovalPhase,
} from '../hub-approvals'
import { HUB_APPROVAL_UNKNOWN_WARNING } from '../hub-approvals/unknown'
import { closesIn, distinctAccount, HubApprovalPhasePill, HubApprovalWaitNote, HubProviderMark, HubRawDetails, openPhaseLabel } from './parts'
import { HubActionPreviewView } from './preview'

/** The owner's answer to one held call. `allow` also grants a standing permission. */
export type HubApprovalDecision =
  | { kind: 'approve' }
  | { kind: 'deny' }
  | { kind: 'allow'; duration: '24h' | 'always'; scope: string }

/** What a standing permission for one call may cover, or why none can. */
export type HubApprovalPermissions =
  | { scopes: ReadonlyArray<{ id: string; label: string }> }
  | { never: string }

export interface HubApprovalDockProps {
  /** Every held call; open, running and uncertain calls stay visible until resolved or dismissed. */
  items: readonly HubApprovalItem[]
  onDecide: (item: HubApprovalItem, decision: HubApprovalDecision) => Promise<void>
  /** Standing-permission choices for a call; omit when the host offers none. */
  permissions?: (item: HubApprovalItem) => HubApprovalPermissions | null
  /** Show the call where the agent made it. */
  onOpen?: (item: HubApprovalItem) => void
  /** Bring one call to the front, e.g. after it was picked in the Approvals list. */
  focusId?: string | null
  className?: string
}

/** How long a finished call stays in the dock, so its result is seen where it was approved. */
const DONE_VISIBLE_MS = 6_000

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

function Progress({ item }: { item: HubApprovalItem }) {
  const provider = presentHubAction(item).provider.name
  if (item.phase === 'queued' || item.phase === 'running') {
    return (
      <p role="status" className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Loader2 aria-hidden className="size-4 animate-spin text-[var(--surface-info-text)]" />
        {item.phase === 'queued' ? 'Approved. It runs when the agent’s turn finishes…' : `Running on ${provider}…`}
      </p>
    )
  }
  if (item.phase === 'done') {
    const receipt = hubActionReceipt(item)
    return (
      <p role="status" className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
        <Check aria-hidden className="size-4 shrink-0 text-[var(--surface-success-text)]" />
        {receipt.href
          ? <a href={receipt.href} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 hover:underline"><span className="truncate">{receipt.title}</span><ExternalLink aria-hidden className="size-4 shrink-0 text-muted-foreground" /></a>
          : <span className="truncate">{receipt.title}</span>}
      </p>
    )
  }
  if (item.phase === 'unknown') {
    return (
      <p role="alert" className="break-words text-sm text-[var(--surface-warning-text)]">
        <span className="font-medium">May have run.</span> {HUB_APPROVAL_UNKNOWN_WARNING}
      </p>
    )
  }
  if (item.phase === 'failed') {
    return (
      <p role="alert" className="break-words text-sm text-[var(--surface-danger-text)]">
        {hubActionReceipt(item).title}{item.error ? `: ${item.error}` : '.'}
      </p>
    )
  }
  return null
}

/**
 * The calls waiting on the owner, pinned above the composer so a held action
 * never scrolls away. Each shows what it does, where, as which account, and a
 * preview drawn like its integration; Approve, Deny and the standing
 * permissions a host offers sit beside it. Approving shows the run in place —
 * starting, running, then the result — without leaving the conversation.
 */
export function HubApprovalDock({ items, onDecide, permissions, onOpen, focusId, className = '' }: HubApprovalDockProps) {
  const now = useNow(30_000)
  // Calls that finished while this dock watched them stay with their result: a
  // success briefly, a failure until dismissed. Uncertain outcomes also stay
  // visible after remount or status reload, until dismissed in this session.
  const watched = useRef(new Map<string, HubApprovalPhase>())
  const [settled, setSettled] = useState<Record<string, number>>({})
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [submitting, setSubmitting] = useState<{ id: string; label: string } | null>(null)
  const [error, setError] = useState<{ id: string; message: string } | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [permissionsOpen, setPermissionsOpen] = useState(false)
  const [scope, setScope] = useState<string | null>(null)

  useEffect(() => {
    const finishedNow: Record<string, number> = {}
    for (const item of items) {
      const before = watched.current.get(item.id)
      const wasLive = before !== undefined && (HUB_APPROVAL_OPEN_PHASES.has(before) || HUB_APPROVAL_ACTIVE_PHASES.has(before))
      if (wasLive && (item.phase === 'done' || item.phase === 'failed' || item.phase === 'unknown')) finishedNow[item.id] = Date.now()
      watched.current.set(item.id, item.phase)
    }
    if (Object.keys(finishedNow).length > 0) setSettled((current) => ({ ...current, ...finishedNow }))
  }, [items])

  useEffect(() => {
    const doneIds = Object.entries(settled).filter(([id]) => items.find((item) => item.id === id)?.phase === 'done')
    if (doneIds.length === 0) return
    const oldest = Math.min(...doneIds.map(([, at]) => at))
    const timer = setTimeout(() => {
      const cutoff = Date.now() - DONE_VISIBLE_MS
      setSettled((current) => Object.fromEntries(Object.entries(current).filter(([id, at]) => at > cutoff || items.find((item) => item.id === id)?.phase !== 'done')))
    }, Math.max(0, oldest + DONE_VISIBLE_MS - Date.now()))
    return () => clearTimeout(timer)
  }, [settled, items])

  const queue = useMemo(() => items.filter((item) => !dismissed.has(item.id) && (
    HUB_APPROVAL_OPEN_PHASES.has(item.phase)
    || HUB_APPROVAL_ACTIVE_PHASES.has(item.phase)
    || item.phase === 'unknown'
    || item.id in settled
    || submitting?.id === item.id
  )), [items, dismissed, settled, submitting])

  useEffect(() => {
    if (focusId && queue.some((item) => item.id === focusId)) {
      setActiveId(focusId)
      setCollapsed(false)
    }
  }, [focusId, queue])

  const activeIndex = Math.max(0, queue.findIndex((item) => item.id === activeId))
  const active = queue[activeIndex]

  // When the shown call finishes and its result has been seen, move to the next one waiting.
  useEffect(() => {
    if (!active || activeId === active.id) return
    setActiveId(active.id)
  }, [active, activeId])
  useEffect(() => {
    setPermissionsOpen(false)
    setScope(null)
  }, [active?.id])

  if (!active) return null
  const presentation = presentHubAction(active)
  const waitingCount = queue.filter((item) => HUB_APPROVAL_OPEN_PHASES.has(item.phase)).length
  const choices = permissions?.(active) ?? null
  const scopes = choices && 'scopes' in choices ? choices.scopes : []
  const chosenScope = scope ?? scopes[0]?.id ?? null
  const busy = submitting?.id === active.id
  const decidable = active.phase === 'waiting' && !busy
  const closing = active.phase === 'waiting' ? closesIn(active.expiresAt, now) : null
  const account = distinctAccount(active.account, presentation.provider.name)
  const subtitle = [presentation.provider.name, account ? `as ${account}` : null, closing].filter(Boolean).join(' · ')

  async function decide(decision: HubApprovalDecision, label: string) {
    if (!active || submitting) return
    setSubmitting({ id: active.id, label })
    setError(null)
    try {
      await onDecide(active, decision)
    } catch (cause) {
      setError({ id: active.id, message: cause instanceof Error ? cause.message : 'The decision did not go through. Try again.' })
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <section
      aria-label={active.phase === 'unknown' ? 'Action may have run' : 'Waiting for your approval'}
      data-hub-approval-dock={active.id}
      className={`overflow-hidden rounded-2xl border border-[var(--surface-warning-border)] bg-card shadow-md ${className}`}
    >
      {queue.length > 1 && (
        <div className="border-b border-border bg-muted/40 px-1.5 pb-1.5 pt-2">
          <p className="px-2 pb-1 text-sm font-medium text-muted-foreground" aria-live="polite">
            {waitingCount === 0 ? `${queue.length} requests` : waitingCount === 1 ? '1 request waiting' : `${waitingCount} requests waiting`}
          </p>
          <ul aria-label="Requests in this conversation" className="max-h-32 space-y-0.5 overflow-y-auto sm:max-h-40">
            {queue.map((item) => {
              const shown = presentHubAction(item)
              const current = item.id === active.id
              return (
                <li key={item.id}>
                  <Button
                    variant="bare"
                    aria-current={current ? 'true' : undefined}
                    onClick={() => {
                      setActiveId(item.id)
                      setCollapsed(false)
                    }}
                    className={`flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors ${current ? 'bg-card shadow-sm' : 'hover:bg-card/70'}`}
                  >
                    <HubProviderMark providerId={shown.provider.id} name={shown.provider.name} size={24} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {item.phase === 'done' ? hubActionReceipt(item).title : shown.title}
                    </span>
                    <HubApprovalPhasePill phase={item.phase} label={openPhaseLabel(item)} />
                  </Button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
      <div className="flex items-start gap-3 px-4 pt-3">
        <HubProviderMark providerId={presentation.provider.id} name={presentation.provider.name} size={28} />
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 break-words text-base font-semibold leading-6 text-foreground" title={presentation.title}>{presentation.title}</h3>
          <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={collapsed ? 'Show the request' : 'Hide the preview'}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <ChevronDown className={`transition-transform ${collapsed ? '-rotate-90' : ''}`} />
        </Button>
      </div>

      {!collapsed && (
        <div className="max-h-48 space-y-3 overflow-y-auto px-4 pt-3 sm:max-h-80">
          {active.bundle?.steps && active.bundle.steps.length > 0 && (
            <ol className="space-y-1 text-sm" aria-label="Steps this approval covers">
              {active.bundle.steps.map((stepItem, index) => (
                <li key={index} className={`flex items-center gap-2 ${stepItem.state === 'current' ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
                  <span className={`flex size-5 shrink-0 items-center justify-center rounded-full border text-sm tabular-nums ${stepItem.state === 'done' ? 'border-transparent bg-[var(--surface-success-bg)] text-[var(--surface-success-text)]' : 'border-border'}`}>
                    {stepItem.state === 'done' ? <Check aria-hidden className="size-3.5" /> : index + 1}
                  </span>
                  {stepItem.label}
                </li>
              ))}
            </ol>
          )}
          <HubActionPreviewView preview={presentation.preview} account={active.account} />
          <HubRawDetails sections={[{ label: 'Call', value: { action: active.actionPath, input: active.input } }]} />
        </div>
      )}

      <div className="space-y-3 px-4 pb-4 pt-3">
        {busy && submitting && !HUB_APPROVAL_ACTIVE_PHASES.has(active.phase) && active.phase === 'waiting' && (
          <p role="status" className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Loader2 aria-hidden className="size-4 animate-spin text-[var(--surface-info-text)]" />
            {submitting.label}
          </p>
        )}
        <Progress item={active} />
        {error?.id === active.id && active.phase === 'waiting' && <p role="alert" className="text-sm text-[var(--surface-danger-text)]">{error.message}</p>}
        {HUB_APPROVAL_OPEN_PHASES.has(active.phase) && active.wait && <HubApprovalWaitNote wait={active.wait} />}
        {active.phase === 'blocked' && !active.wait && <p className="text-sm text-muted-foreground">The workspace owner approves this request.</p>}

        {decidable && permissionsOpen && scopes.length > 0 && (
          <fieldset className="space-y-2 rounded-xl border border-border bg-muted/30 px-3 py-3">
            <legend className="sr-only">Standing permission</legend>
            {scopes.length > 1 && (
              <RadioGroup
                aria-label="What the permission covers"
                value={chosenScope ?? undefined}
                onValueChange={setScope}
                className="gap-1.5"
              >
                {scopes.map((option) => (
                  <div key={option.id} className="flex min-h-8 items-center gap-2">
                    <RadioGroupItem id={`hub-scope-${active.id}-${option.id}`} value={option.id} />
                    <Label htmlFor={`hub-scope-${active.id}-${option.id}`} className="cursor-pointer text-sm font-normal text-foreground">{option.label}</Label>
                  </div>
                ))}
              </RadioGroup>
            )}
            {scopes.length === 1 && <p className="text-sm text-foreground">{scopes[0]?.label}</p>}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => chosenScope && void decide({ kind: 'allow', duration: '24h', scope: chosenScope }, 'Approving and allowing for 24 hours…')}>
                Approve and allow for 24 hours
              </Button>
              <Button variant="outline" onClick={() => chosenScope && void decide({ kind: 'allow', duration: 'always', scope: chosenScope }, 'Approving and allowing from now on…')}>
                Approve and always allow
              </Button>
            </div>
          </fieldset>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {decidable && (
            <>
              <Button onClick={() => void decide({ kind: 'approve' }, 'Approving…')}>Approve</Button>
              <Button variant="outline" onClick={() => void decide({ kind: 'deny' }, 'Denying…')}>Deny</Button>
              {scopes.length > 0 && (
                <Button variant="ghost" aria-expanded={permissionsOpen} onClick={() => setPermissionsOpen((value) => !value)}>
                  {permissionsOpen ? 'Fewer options' : 'Allow future calls…'}
                </Button>
              )}
            </>
          )}
          {(active.phase === 'failed' || active.phase === 'unknown') && (
            <Button variant="outline" onClick={() => setDismissed((current) => new Set([...current, active.id]))}>
              <X aria-hidden /> Dismiss
            </Button>
          )}
          <span className="flex-1" />
          {decidable && choices && 'never' in choices && !active.wait && (
            <span className="text-sm text-muted-foreground">{choices.never}</span>
          )}
          {onOpen && (
            <Button variant="ghost" onClick={() => onOpen(active)}>View in chat</Button>
          )}
        </div>
      </div>
    </section>
  )
}
