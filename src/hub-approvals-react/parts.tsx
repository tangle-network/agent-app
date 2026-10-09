import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { ProviderIcon } from '@tangle-network/sandbox-ui/integrations'
import { Button, StatusPill, type StatusTone } from '@tangle-network/ui/primitives'

import { HUB_APPROVAL_PHASE_LABELS, type HubApprovalPhase } from '../hub-approvals'

const PHASE_TONES: Record<HubApprovalPhase, StatusTone> = {
  waiting: 'warning',
  blocked: 'warning',
  queued: 'running',
  running: 'running',
  done: 'success',
  failed: 'danger',
  denied: 'neutral',
  expired: 'neutral',
}

/** A phase as a toned pill: glyph, colour and label. */
export function HubApprovalPhasePill({ phase, label }: { phase: HubApprovalPhase; label?: string }) {
  return (
    <StatusPill tone={PHASE_TONES[phase]} size="md" className="shrink-0 whitespace-nowrap">
      {label ?? HUB_APPROVAL_PHASE_LABELS[phase]}
    </StatusPill>
  )
}

/** The integration's own logo on a neutral tile, so dark marks stay legible. */
export function HubProviderMark({ providerId, name, size = 28 }: { providerId: string; name: string; size?: number }) {
  const inner = Math.round(size * 0.64)
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-lg border border-border bg-background"
      style={{ width: size, height: size }}
    >
      <ProviderIcon id={providerId} displayName={name} size={inner} className="rounded-sm" />
    </span>
  )
}

/** Raw JSON behind a disclosure, for the person who wants the exact call. */
export function HubRawDetails({ sections }: { sections: ReadonlyArray<{ label: string; value: unknown }> }) {
  const [open, setOpen] = useState(false)
  const shown = sections.filter((section) => section.value !== undefined && section.value !== null && section.value !== '')
  if (shown.length === 0) return null
  return (
    <div>
      <Button
        variant="bare"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex min-h-8 items-center gap-1 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRight aria-hidden className={`size-4 transition-transform ${open ? 'rotate-90' : ''}`} />
        Details
      </Button>
      {open && (
        <div className="mt-2 space-y-3">
          {shown.map((section) => (
            <div key={section.label} className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">{section.label}</p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-muted/40 p-3 font-mono text-sm leading-5 text-foreground">
                {typeof section.value === 'string' ? section.value : JSON.stringify(section.value, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** A `label value` list that wraps on a phone. */
export function HubFieldList({ fields }: { fields: ReadonlyArray<{ label: string; value: string; href?: string; mono?: boolean }> }) {
  if (fields.length === 0) return null
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
      {fields.map((field) => (
        <div key={`${field.label}:${field.value}`} className="flex min-w-0 max-w-full items-baseline gap-2">
          <dt className="shrink-0 text-muted-foreground">{field.label}</dt>
          <dd className={`min-w-0 truncate text-foreground ${field.mono ? 'font-mono' : ''}`} title={field.value}>
            {field.href
              ? <a href={field.href} target="_blank" rel="noreferrer" className="text-[var(--accent-text)] underline-offset-2 hover:underline">{field.value}</a>
              : field.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function Chip({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return (
    <span className={`inline-flex max-w-full items-center truncate rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-sm text-foreground ${mono ? 'font-mono' : ''}`}>
      {children}
    </span>
  )
}

/** When a decision window closes, relative to now: `in 23 h`, `in 5 min`. */
export function closesIn(expiresAt: string | null | undefined, now = Date.now()): string | null {
  if (!expiresAt) return null
  const minutes = Math.ceil((Date.parse(expiresAt) - now) / 60_000)
  if (!Number.isFinite(minutes) || minutes <= 0) return null
  return minutes >= 120 ? `closes in ${Math.round(minutes / 60)} h` : `closes in ${minutes} min`
}

/** A short relative time: `just now`, `4 min ago`, `3 h ago`, then the date. */
export function relativeTime(at: string | null | undefined, now = Date.now()): string | null {
  if (!at) return null
  const then = Date.parse(at)
  if (!Number.isFinite(then)) return null
  const minutes = Math.round((now - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
