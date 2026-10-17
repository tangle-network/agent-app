/**
 * The one save bar a group of settings may have, for values that only make
 * sense saved together (a set of spend caps). Pass it as a `SettingsSection`
 * footer. Save is the primary action only while there are changes; a refusal
 * shows its sentence here and the edits stay. "Saved" shows for two seconds
 * after `state` becomes `saved`, as a row's does. On a narrow card with
 * unsaved changes the footer sticks to the bottom of the screen, so Save stays
 * in reach while the person scrolls the fields above it.
 */

import { Button } from '@tangle-network/ui/primitives'
import { CircleAlert, Lock } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { SAVED_VISIBLE_MS, SavedStatus } from './save-status'

// These style the footer the bar sits in (`:has(> bar)`): the bar is that
// footer's only child, so only the footer can stick within the card.
const STICKY_FOOTER = '@max-[34rem]/settings-section:[:has(>&)]:sticky @max-[34rem]/settings-section:[:has(>&)]:bottom-0 @max-[34rem]/settings-section:[:has(>&)]:z-10'

export interface SettingsSaveBarProps {
  /** How many values differ from the saved ones. */
  changes: number
  /** Replaces the "2 unsaved changes" count. */
  summary?: ReactNode
  onDiscard: () => void
  onSave: () => void
  state: 'idle' | 'saving' | 'saved' | 'failed'
  /** The refusal to show while `state` is `failed`. */
  error?: ReactNode
  /** The verb on the save button. */
  saveLabel?: string
  /** Why the person cannot save, naming who can. Replaces the buttons' availability. */
  disabledReason?: ReactNode
}

export function SettingsSaveBar({
  changes,
  summary,
  onDiscard,
  onSave,
  state,
  error,
  saveLabel = 'Save changes',
  disabledReason,
}: SettingsSaveBarProps) {
  const saving = state === 'saving'
  const dirty = changes > 0
  const [showSaved, setShowSaved] = useState(state === 'saved')
  useEffect(() => {
    setShowSaved(state === 'saved')
    if (state !== 'saved') return
    const timer = setTimeout(() => setShowSaved(false), SAVED_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [state])
  const message = disabledReason != null
    ? <span className="flex items-start gap-1.5 text-muted-foreground"><Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" /><span className="min-w-0">{disabledReason}</span></span>
    : state === 'failed' && error != null
      ? <span role="alert" className="flex items-start gap-1.5 text-[var(--surface-danger-text)]"><CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" /><span className="min-w-0 [overflow-wrap:anywhere]">{error}</span></span>
      : summary ?? (dirty
        ? <span className="text-muted-foreground">{changes === 1 ? '1 unsaved change' : `${changes} unsaved changes`}</span>
        : showSaved ? <SavedStatus /> : <span className="text-muted-foreground">No unsaved changes</span>)
  const sticky = dirty && disabledReason == null
  return (
    <div
      className={`flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-4 gap-y-2${sticky ? ` ${STICKY_FOOTER}` : ''}`}
      data-settings-save-bar
      data-dirty={sticky || undefined}
    >
      <div aria-live="polite" className="min-w-0 text-sm">{message}</div>
      {disabledReason == null && (
        <div className="ml-auto flex shrink-0 gap-2">
          {dirty && <Button type="button" variant="ghost" disabled={saving} onClick={onDiscard}>Discard</Button>}
          <Button type="button" variant={dirty ? 'default' : 'outline'} disabled={!dirty || saving} loading={saving} onClick={onSave}>
            {saveLabel}
          </Button>
        </div>
      )}
    </div>
  )
}
