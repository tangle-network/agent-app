/**
 * The words a settings row shows after its label while a write is in flight
 * or just landed. One size (14px) and no colour at rest: "Saved" is the only
 * green, and it fades on its own.
 */

import { Check, LoaderCircle } from 'lucide-react'

/** How long "Saving…" waits before it shows (`--interaction-pending-delay`), so a fast write shows only "Saved". */
export const PENDING_DELAY_MS = 200

/** How long "Saved" stays after a confirmed write. */
export const SAVED_VISIBLE_MS = 2000

export function SavingStatus({ label = 'Saving…' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-sm text-muted-foreground" data-setting-status="saving">
      <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
      {label}
    </span>
  )
}

export function SavedStatus({ label = 'Saved' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-sm text-[var(--surface-success-text)]" data-setting-status="saved">
      <Check aria-hidden="true" className="size-4" />
      {label}
    </span>
  )
}

export function UnsavedStatus({ label = 'Unsaved' }: { label?: string }) {
  return <span className="text-sm text-muted-foreground" data-setting-status="unsaved">{label}</span>
}
